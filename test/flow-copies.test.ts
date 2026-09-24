/**
 * `copies: true` end to end, on real repositories: each branch works in a
 * copy of the tree as it stands, the patches land in branch order once every
 * branch ended, a conflict stops the landing and shows in the block's output,
 * and no copy outlives its block. A branch writes through a `check`, which
 * runs a real script in the tree it stands in.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { gitPort } from "../src/git/index.ts";
import { checkRun, dryRunFlow, runFlow, type FlowPorts } from "../src/flow/index.ts";
import { bashCheck, type CheckScript } from "../src/verify.ts";
import { checked, flowSpawn, launched, refused } from "./fixtures/flow.ts";
import { git, plainDirectory, repository } from "./fixtures/repo.ts";

const PORTS: FlowPorts = { git: gitPort(), check: bashCheck() };

/**
 * A `copies: true` parallel whose branch `a` runs `a.sh` and branch `b` runs
 * `b.sh`, each check with `keys`, then `after`; `look`, an agent before the
 * check in `a`, with `looking`.
 */
function both({ keys = "", after = "", looking = false } = {}): ReturnType<typeof checked> {
	const look = looking ? "        - id: look\n          agent: scout\n" : "";
	const branch = (name: string, before = "") => `      ${name}:\n${before}        - id: w${name}\n          check: .pi/checks/${name}.sh${keys}\n`;
	return checked(`  - id: both\n    copies: true\n    parallel:\n${branch("a", look)}${branch("b")}${after}`, { ...(looking && { look: "Look." }), ...(after && { read: "Read." }) });
}

/** A repository holding the two branch scripts, uncommitted. */
function scripts(a: string, b: string, files: Record<string, string> = {}): string {
	return repository({ ".pi/checks/a.sh": a, ".pi/checks/b.sh": b, ...files });
}

const worktrees = (cwd: string) => git(cwd, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;

describe("a copies block, read and launched", () => {
	test("gives each branch's entry `landed` and `refused?`, and refuses a memory scope from outside the block", () => {
		assert.ok(both().nodes.length === 1);
		const scoped = (memory: string) => `  - id: both\n    copies: true\n    parallel:\n      a:\n        - id: x\n          agent: scout\n          memory: ${memory}\n      b:\n        - id: y\n          agent: scout`;
		assert.deepEqual(refused(scoped("flow"), "## x\nX.\n\n## y\nY."), ["memory-outside-copies both/x.memory"]);
		assert.ok(checked(scoped("both"), { x: "X.", y: "Y." }).nodes.length === 1);
	});

	test("needs a `git` port and a repository", async () => {
		const faults = async (cwd: string, ports: FlowPorts) => {
			const result = await checkRun(both(), { cwd, ports, somebodyThere: false });
			return result.ok ? [] : result.faults.map(({ code, at }) => `${code} ${at}`).filter((fault) => !fault.startsWith("check-"));
		};
		assert.deepEqual(await faults(scripts("", ""), { check: bashCheck() }), ["git-port-missing both.copies"]);
		assert.deepEqual(await faults(plainDirectory(), PORTS), ["not-a-repository both.copies"]);
	});
});

describe("a copies block, run", () => {
	test("runs each branch in its own copy of the tree as it stands, lands every patch, and leaves no copy behind", async () => {
		const cwd = scripts("test -f pre.txt && echo a > a.txt", "sleep 0.2; echo b > b.txt; test ! -f a.txt", { "pre.txt": "uncommitted\n" });
		const flow = both({ looking: true });
		const fake = flowSpawn([[{ text: "looked" }]]);
		const result = await runFlow(await launched(flow, { cwd, ports: PORTS }), "x", { spawn: fake.spawn });
		const output = result.ok ? (result.output as Record<string, { ok: boolean; output: { passed: boolean }; landed: boolean }>) : {};
		assert.deepEqual(["a", "b"].map((name) => [output[name]?.output.passed, output[name]?.landed]), [[true, true], [true, true]], JSON.stringify(result));
		const spawnedIn = fake.requested[0]?.options.cwd ?? "";
		assert.ok(spawnedIn !== cwd && !fs.existsSync(spawnedIn), "the agent worked in a copy, removed with its branch");
		assert.deepEqual([fs.readFileSync(path.join(cwd, "a.txt"), "utf-8"), fs.readFileSync(path.join(cwd, "b.txt"), "utf-8")], ["a\n", "b\n"]);
		assert.deepEqual([worktrees(cwd), git(cwd, "branch", "--show-current"), git(cwd, "rev-list", "--count", "HEAD")], [1, "main", "1"]);
	});

	test("gives each map item a copy, down through a loop inside it, and lands them in item order", async () => {
		const cwd = scripts('test "$(basename "$PWD")" = tree && mktemp -p . item-XXXXXX', "");
		const nodes = "  - id: work\n    map: [x, y]\n    concurrency: 2\n    copies: true\n    do:\n      - id: again\n        loop: w.output.passed\n        max: 1\n        do:\n          - id: w\n            check: .pi/checks/a.sh";
		const result = await runFlow(await launched(checked(nodes, {}), { cwd, ports: PORTS }), "x");
		const items = result.ok ? (result.output as { item: string; ok: boolean; landed: boolean }[]) : [];
		assert.deepEqual(items.map(({ item, ok, landed }) => [item, ok, landed]), [["x", true, true], ["y", true, true]], JSON.stringify(result));
		assert.equal(fs.readdirSync(cwd).filter((name) => name.startsWith("item-")).length, 2);
	});

	test("lands in branch order whatever order the branches ended in, a conflict stopping the landing in the block's output", async () => {
		const cwd = scripts("sleep 0.3; echo a > same.txt", "echo b > same.txt");
		const flow = both({ after: "  - id: read\n    agent: scout\n    reads: [both.output.b.refused]" });
		const fake = flowSpawn([[{ text: "read" }]]);
		const result = await runFlow(await launched(flow, { cwd, ports: PORTS }), "x", { spawn: fake.spawn });
		assert.ok(result.ok, JSON.stringify(result));
		assert.equal(fs.readFileSync(path.join(cwd, "same.txt"), "utf-8"), "a\n");
		assert.match(fake.created[0]?.prompts[0] ?? "", /## both\.output\.b\.refused\n\n.*same\.txt/);
	});

	test("lands a failed branch's patch like the others, and what landed stays when the block fails", async () => {
		const cwd = scripts("echo a > a.txt; sleep 30", "echo b > b.txt");
		const result = await runFlow(await launched(both({ keys: "\n          timeout: 1s" }), { cwd, ports: PORTS }), "x");
		assert.deepEqual(!result.ok && [result.error.kind, result.path], ["timeout", "both/a/wa"]);
		assert.ok(["a.txt", "b.txt"].every((name) => fs.existsSync(path.join(cwd, name))));
		assert.equal(worktrees(cwd), 1);
	});

	test("stopped, lands nothing and removes every copy, the work kept on its copy's branch", async () => {
		const cwd = scripts("echo a > a.txt; sleep 30", "sleep 30");
		const stop = new AbortController();
		// Stopped once `a` has written, mid-script: a stop on a clock can land
		// before the branch starts, and a branch that wrote nothing keeps nothing.
		const run = bashCheck();
		const stopOnWrite: CheckScript = async (request) => {
			const watcher = fs.watch(request.cwd, (_, name) => name === "a.txt" && stop.abort());
			try {
				return await run(request);
			} finally {
				watcher.close();
			}
		};
		const result = await runFlow(await launched(both(), { cwd, ports: { git: PORTS.git, check: stopOnWrite } }), "x", { signal: stop.signal });
		assert.deepEqual(!result.ok && result.error.kind, "stopped");
		assert.deepEqual([fs.existsSync(path.join(cwd, "a.txt")), worktrees(cwd)], [false, 1]);
		assert.match(git(cwd, "log", "--all", "--name-only", "--format="), /^a\.txt$/m);
	});
});

describe("a copies block in a dry run", () => {
	test("makes no copy, and every branch reads as landed", async () => {
		const run = await dryRunFlow(both(), "x", { "both/wa": { passed: true, report: "" }, "both/wb": { passed: false, report: "red" } });
		assert.deepEqual(run.ok && "journal" in run && run.output, {
			a: { ok: true, output: { passed: true, report: "" }, landed: true },
			b: { ok: true, output: { passed: false, report: "red" }, landed: true },
		});
	});
});
