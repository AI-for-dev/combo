/**
 * The `subagent` tool's arguments, as a model reads them: which mode a call
 * infers, and which modes each field's description says read it.
 *
 * What a mode reads is measured on the tool body itself, never copied from
 * the table that writes the descriptions: a field a mode starts or stops
 * reading makes its description wrong, and this file red.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { executeSubagent } from "../extension/execute.ts";
import { inferMode, MODES, Schema, type Mode, type Params } from "../extension/params.ts";
import { fakeSpawn, offeredTools, testAgent } from "./fixtures/fake-subagent.ts";

describe("inferMode", () => {
	test("reads the mode from the arguments that were actually given", () => {
		assert.equal(inferMode({}), "single");
		assert.equal(inferMode({ agent: "scout", task: "x" }), "single");
		assert.equal(inferMode({ agent: "scout", tasks: ["a", "b"] }), "parallel");
		assert.equal(inferMode({ steps: ["coder", "reviewer"] }), "chain");
		assert.equal(inferMode({ steps: ["coder"], until: "LGTM" }), "loop");
		assert.equal(inferMode({ steps: ["coder"], maxIterations: 2 }), "loop");
		assert.equal(inferMode({ agent: "scout", tasks: ["a", "b"], reduceWith: "reviewer" }), "reduce");
		assert.equal(inferMode({ agent: "scout", candidates: ["coder"] }), "route", "the cheaper reading wins when nothing else says");
	});

	test("candidates beside a field only orchestrate reads is an orchestration", () => {
		assert.equal(inferMode({ agent: "scout", candidates: ["coder"], reduceWith: "reviewer" }), "orchestrate");
		assert.equal(inferMode({ agent: "scout", candidates: ["coder"], maxTasks: 3 }), "orchestrate");
		assert.equal(inferMode({ agent: "scout", candidates: ["coder"], concurrency: 2 }), "orchestrate");
	});

	test("an explicit mode always wins over the inference", () => {
		assert.equal(inferMode({ mode: "chain", tasks: ["a"] }), "chain");
		assert.equal(inferMode({ mode: "route", candidates: ["coder"], maxTasks: 3 }), "route");
	});
});

/** A value for every field but `mode` and `flow`, each one a mode could run on. */
const EVERY: Params = {
	agent: "scout",
	task: "x",
	tasks: ["a"],
	steps: ["coder"],
	lifetime: "task",
	model: "fake/model",
	concurrency: 2,
	until: "LGTM",
	maxIterations: 1,
	maxTasks: 2,
	maxDepth: 1,
	candidates: ["coder"],
	timeoutMs: 60_000,
	openInHerdr: false,
	scope: "user",
	reduceWith: "reviewer",
	herdrAll: false,
	export: true,
};

/** Every agent delegates, so the one field read only by a delegating agent is read. */
const agents = ["scout", "coder", "reviewer"].map((name) => testAgent(name, { tools: ["subagent"] }));

/** The fields a run in `mode` reads, found by watching it read them. */
async function readBy(mode: Exclude<Mode, "flow">): Promise<Set<string>> {
	const read = new Set<string>();
	const params = new Proxy({ ...EVERY, mode }, { get: (target, key, receiver) => (read.add(String(key)), Reflect.get(target, key, receiver)) });
	const fake = fakeSpawn((_task, _agent, options) => {
		offeredTools(options);
		return { output: `coder\n${JSON.stringify({ agent: "coder", task: "x" })}\nLGTM` };
	});
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-params-"));
	try {
		await executeSubagent(params, { loadAgents: () => agents, tickMs: 0, spawn: fake.spawn, runDir: () => dir });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	// `mode` picks the mode and `flow` is looked at to refuse it beside
	// another: neither is what the mode reads.
	read.delete("mode");
	read.delete("flow");
	return read;
}

/** Whether `flow` mode takes `field`: it refuses, by name, every field it does not read. */
async function flowTakes(field: keyof Params): Promise<boolean> {
	const params = { flow: "x", task: "x", [field]: field === "flow" ? "x" : field === "task" ? "x" : EVERY[field] };
	const sentinel = new Error("read past the check");
	const refused = await executeSubagent(params, {
		loadFlowCatalogue: () => {
			throw sentinel;
		},
	}).then(
		() => false,
		(error: unknown) => error !== sentinel,
	);
	return !refused;
}

/** The modes a description says read its field: "Read by every mode", "every mode but X", or a list. */
function modesNamed(description: string): Set<Mode> {
	const said = /Read by ([^.]+)\.$/.exec(description)?.[1];
	assert.ok(said, `no "Read by ..." sentence closes: ${description}`);
	const but = /^every mode(?: but (\w+))?$/.exec(said);
	if (but) return new Set(MODES.filter((mode) => mode !== but[1]));
	return new Set(said.split(/, | and /) as Mode[]);
}

describe("Schema descriptions", () => {
	test("every field but mode names exactly the modes that read it", async () => {
		const measured = new Map<string, Set<Mode>>();
		for (const mode of MODES) {
			if (mode === "flow") continue;
			for (const field of await readBy(mode)) measured.set(field, (measured.get(field) ?? new Set()).add(mode));
		}
		const fields = Object.keys(Schema.properties).filter((field) => field !== "mode") as (keyof Params)[];
		for (const field of fields) {
			const modes = measured.get(field) ?? new Set<Mode>();
			if (await flowTakes(field)) modes.add("flow");
			const description = (Schema.properties[field] as { description?: string }).description ?? "";
			assert.deepEqual([...modesNamed(description)].sort(), [...modes].sort(), `${field}: ${description}`);
		}
	});

	test("mode says when orchestrate is inferred", () => {
		const { mode, candidates } = Schema.properties as Record<string, { description?: string }>;
		assert.match(mode?.description ?? "", /orchestrate beside/);
		assert.match(candidates?.description ?? "", /orchestrate beside/);
	});
});
