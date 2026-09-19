/**
 * Holds combo's herdr calls to herdr's own schema.
 *
 * `herdr api schema --json` is authoritative, and the reason this exists is
 * that nothing else noticed when it moved. `agent.start` once took an `argv`
 * and a `split` and opened a pane; by protocol 22 it takes a `kind` and a
 * `pane_id` and starts a *recognised* agent in a pane that already exists.
 * Every call combo made was refused, every refusal was swallowed - a reporter
 * is an observer and must never throw - and the suite stayed green over a
 * `/herdr on` that opened nothing at all.
 *
 * A fake cannot tell you that herdr changed shape, so this asks herdr. It runs
 * the reporter through a whole subagent's life against a recording transport,
 * then validates what it recorded, which is why it cannot drift from the code
 * the way a list of example payloads would.
 *
 *   node scripts/check-herdr.ts      # needs the herdr binary, not a herdr session
 *
 * Exits non-zero on the first call herdr would refuse.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHerdrReporterWith } from "../src/reporters/herdr.ts";
import { emptyUsage } from "../src/usage.ts";
import type { HerdrSend } from "../src/reporters/herdr-client.ts";

type Schema = { properties?: Record<string, unknown>; required?: string[]; $ref?: string };

/** The `$defs` entry `method`'s params must match, or `undefined` if herdr has no such method. */
function paramsSchema(request: unknown, defs: Record<string, Schema>, method: string): Schema | undefined {
	const found: Schema[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		const branch = node as { properties?: { method?: { const?: string }; params?: { $ref?: string } } };
		if (branch.properties?.method?.const === method && branch.properties.params?.$ref) {
			found.push(defs[branch.properties.params.$ref.split("/").pop() as string] as Schema);
		}
		Object.values(node).forEach(walk);
	};
	walk(request);
	return found[0];
}

/**
 * Drives one subagent's whole life, and gives back every request it made.
 *
 * Asynchronous because the reporter's are: every call after the split is
 * queued behind the pending pane id, and reading the list before those settle
 * is how an earlier draft of this checked one call out of six.
 */
async function record(): Promise<{ method: string; params: Record<string, unknown> }[]> {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const send: HerdrSend = async (method, params) => {
		calls.push({ method, params });
		return method === "pane.split" ? { result: { pane: { pane_id: "w1:p9" } } } : { result: {} };
	};

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-check-"));
	const report = createHerdrReporterWith(send, { dir, all: true, pane: "w1:p1" });
	report({ type: "spawn", id: "member#1", agent: "member", order: 1, lifetime: "workflow", openInHerdr: true });
	report({ type: "status", id: "member#1", status: "working", task: "describe one file" });
	report({ type: "tool", id: "member#1", name: "read", args: { path: "src/reporters/console.ts" } });
	report({ type: "text", id: "member#1", delta: "it prints what happens" });
	report({ type: "post", id: "member#1", post: { id: "p1", from: "member#1", kind: "result", text: "console.ts", at: 1 } });
	report({ type: "status", id: "member#1", status: "done" });
	report({ type: "close", id: "member#1", result: { agent: "member", output: "", messages: [], ok: true, usage: emptyUsage() } });
	await new Promise((resolve) => setTimeout(resolve, 50));
	fs.rmSync(dir, { recursive: true, force: true });
	return calls;
}

const schema = JSON.parse(execFileSync("herdr", ["api", "schema", "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const request = schema.schemas.request;
console.log(`herdr protocol ${schema.protocol}\n`);

let refused = 0;
const checked = new Set<string>();
for (const { method, params } of await record()) {
	if (checked.has(method)) continue;
	checked.add(method);

	const shape = paramsSchema(request, request.$defs, method);
	if (!shape) {
		console.log(`✗ ${method}  herdr has no such method`);
		refused++;
		continue;
	}

	const sent = Object.keys(params);
	const missing = (shape.required ?? []).filter((key) => !sent.includes(key));
	const unknown = sent.filter((key) => !(key in (shape.properties ?? {})));
	// Missing is a refusal - herdr answers `invalid_request` and the pane never
	// opens. Unknown is not, today, but it is a field that means nothing to the
	// server, which is what `argv` and `split` had become.
	if (missing.length) refused++;
	console.log(
		`${missing.length ? "✗" : unknown.length ? "!" : "✓"} ${method}` +
			(missing.length ? `  missing ${missing.join(", ")}` : "") +
			(unknown.length ? `  herdr knows no ${unknown.join(", ")}` : ""),
	);
}

console.log();
if (refused > 0) {
	console.log(`${refused} call(s) herdr would refuse. A refusal is silent at runtime: nothing opens, and nothing says so.`);
	process.exit(1);
}
console.log(`${checked.size} calls, all of a shape herdr accepts.`);
