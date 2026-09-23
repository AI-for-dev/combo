/**
 * The blocks the runner joins: `parallel` and `map`, their outputs, the
 * failures they keep, `fail-fast` and its cut, `too-many`, and the scope each
 * branch opens and closes.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SubagentEvent } from "../src/events.ts";
import { runFlow } from "../src/flow/index.ts";
import { stopSwitch } from "../src/stop.ts";
import { checked, flowSpawn } from "./fixtures/flow.ts";

/** What ended at each visit path, as `path ok`, in the order they ended. */
function ends(events: SubagentEvent[]): string[] {
	return events.flatMap((event) => (event.type === "visit_end" ? [`${event.path} ${event.ok}`] : []));
}

function endOf(events: SubagentEvent[], path: string) {
	const found = events.find((event) => event.type === "visit_end" && event.path === path);
	assert.ok(found?.type === "visit_end", `no visit ended at ${path}`);
	return found;
}

const BOTH = `  - id: both
    parallel:
      left:
        - id: look
          agent: scout
      right:
        - id: judge
          agent: reviewer
          output: { fine: boolean }`;
const BOTH_SECTIONS = { look: "Look.", judge: "Judge." };

describe("a parallel", () => {
	test("starts every branch at once, and hands on each as it ended, by branch name", async () => {
		const fake = flowSpawn({ scout: [[{ text: "seen", delayMs: 200 }]], reviewer: [[{ submit: { fine: true }, delayMs: 200 }]] });
		const events: SubagentEvent[] = [];
		const started = performance.now();
		const result = await runFlow(checked(BOTH, BOTH_SECTIONS), "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.ok(performance.now() - started < 350, "the branches ran together");
		assert.deepEqual(result.ok && result.output, { left: { ok: true, output: "seen" }, right: { ok: true, output: { fine: true } } });
		assert.deepEqual(ends(events).sort(), ["both true", "both/left/look true", "both/right/judge true"]);
		const spawned = events.flatMap((event) => (event.type === "spawn" ? [event.visit] : []));
		assert.deepEqual(spawned.sort(), ["both/left/look", "both/right/judge"]);
	});

	test("waits for every branch when one fails, and fails `child` from it", async () => {
		const fake = flowSpawn({ scout: [[{ stopReason: "error" }]], reviewer: [[{ submit: { fine: true }, delayMs: 20 }]] });
		const events: SubagentEvent[] = [];
		const result = await runFlow(checked(BOTH, BOTH_SECTIONS), "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.deepEqual(!result.ok && [result.error, result.path], [{ kind: "provider", message: "boom" }, "both/left/look"]);
		assert.equal(endOf(events, "both/right/judge").ok, true, "the other branch ran to its end");
		assert.deepEqual(endOf(events, "both").error, { kind: "child", message: "both/left/look: provider: boom" });
	});

	test("with `on-fail: continue`, ends `ok: true` and keeps its failed branch", async () => {
		const fake = flowSpawn({ scout: [[{ stopReason: "error" }]], reviewer: [[{ submit: { fine: true } }]], synthesiser: [[{ text: "carried on" }]] });
		const flow = checked(`${BOTH}\n    on-fail: continue\n  - id: after\n    agent: synthesiser\n    reads: [both]`, { ...BOTH_SECTIONS, after: "After." });
		const events: SubagentEvent[] = [];
		const result = await runFlow(flow, "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.deepEqual(result.ok && result.output, "carried on");
		assert.deepEqual(endOf(events, "both").output, { left: { ok: false, error: { kind: "child", message: "both/left/look: provider: boom" } }, right: { ok: true, output: { fine: true } } });
	});

	test("with `fail-fast`, cuts the branches in flight, which end `cancelled`", async () => {
		const fake = flowSpawn({ scout: [[{ stopReason: "error", delayMs: 10 }]], reviewer: [[{ delayMs: 5000 }]] });
		const events: SubagentEvent[] = [];
		const started = performance.now();
		const result = await runFlow(checked(`${BOTH}\n    fail-fast: true`, BOTH_SECTIONS), "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.ok(performance.now() - started < 2000, "the slow branch was really cut short");
		assert.deepEqual(!result.ok && [result.error.kind, result.path], ["provider", "both/left/look"]);
		assert.deepEqual(endOf(events, "both/right/judge").error, { kind: "cancelled", message: "cut by `fail-fast`: both/left/look failed" });
		assert.ok(fake.created.every((session) => session.disposed));
	});

	test("gives each branch a memory scope of its own, closed when the branch ends", async () => {
		const flow = checked(
			`  - id: both\n    parallel:\n      a:\n        - id: one\n          agent: scout\n          memory: both\n        - id: two\n          agent: scout\n          memory: both\n      b:\n        - id: three\n          agent: scout\n          memory: both`,
			{ one: "One.", two: "Two.", three: "Three." },
		);
		const fake = flowSpawn({ scout: [[{ text: "1" }, { text: "2" }], [{ text: "3" }]] });
		const result = await runFlow(flow, "x", { spawn: fake.spawn });
		assert.ok(result.ok);
		assert.deepEqual(fake.created.map((session) => [session.prompts.length, session.disposed]), [[2, true], [1, true]]);
	});

	test("stopped, ends `stopped` with every subagent closed", async () => {
		const fake = flowSpawn({ scout: [[{ delayMs: 5000 }]], reviewer: [[{ delayMs: 5000 }]] });
		const stopping = stopSwitch({ spawn: fake.spawn });
		const running = runFlow(checked(`${BOTH}\n    on-fail: continue`, BOTH_SECTIONS), "x", { spawn: stopping.spawn, signal: stopping.signal });
		setTimeout(() => stopping.all(), 20);
		const result = await running;
		assert.deepEqual(!result.ok && result.error.kind, "stopped");
		assert.deepEqual(fake.created.map((session) => session.disposed), [true, true]);
	});
});

const PLAN = `  - id: plan
    agent: planner
    output: { tasks: [string] }`;
const WORK = `${PLAN}
  - id: work
    map-from: plan.output.tasks
    max: 3
    do:
      - id: act
        agent: scout
        reads: [item]`;
const WORK_SECTIONS = { plan: "Plan.", act: "Act." };

describe("a map", () => {
	test("runs its body once per item, numbered from 1, one at a time, and hands on a list in item order", async () => {
		const fake = flowSpawn([[{ submit: { tasks: ["a", "b"] } }], [{ text: "did a" }], [{ text: "did b" }]]);
		const events: SubagentEvent[] = [];
		let disposedWhenSecondSpawned: boolean | undefined;
		const result = await runFlow(checked(WORK, WORK_SECTIONS), "x", {
			spawn: async (agent, options) => {
				if (fake.created.length === 2) disposedWhenSecondSpawned = fake.created[1]?.disposed;
				return fake.spawn(agent, options);
			},
			onEvent: (event) => events.push(event),
		});
		assert.deepEqual(result.ok && result.output, [
			{ item: "a", ok: true, output: "did a" },
			{ item: "b", ok: true, output: "did b" },
		]);
		assert.deepEqual(ends(events), ["plan true", "work[1]/act true", "work[2]/act true", "work true"]);
		assert.match(fake.created[2]?.prompts[0] ?? "", /^Act\.\n\n## item\n\nb\n/);
		assert.equal(disposedWhenSecondSpawned, true, "`concurrency` defaults to 1");
	});

	test("runs `concurrency` items at once", async () => {
		const fake = flowSpawn({ planner: [[{ submit: { tasks: ["a", "b"] } }]], scout: [[{ text: "a", delayMs: 200 }], [{ text: "b", delayMs: 200 }]] });
		const started = performance.now();
		const result = await runFlow(checked(`${WORK}\n    concurrency: 2`, WORK_SECTIONS), "x", { spawn: fake.spawn });
		assert.ok(result.ok);
		assert.ok(performance.now() - started < 350, "the items ran together");
	});

	test("fails `too-many` before its first item on a list longer than `max:`", async () => {
		const fake = flowSpawn([[{ submit: { tasks: ["a", "b", "c", "d"] } }]]);
		const result = await runFlow(checked(WORK, WORK_SECTIONS), "x", { spawn: fake.spawn });
		assert.deepEqual(!result.ok && [result.error, result.path], [{ kind: "too-many", message: "`plan.output.tasks` holds 4 items, and `max:` is 3" }, "work"]);
		assert.equal(fake.created.length, 1, "no item ran");
	});

	test("keeps a failed item beside the others, and fails from it", async () => {
		const fake = flowSpawn([[{ submit: { tasks: ["a", "b"] } }], [{ stopReason: "error" }], [{ text: "did b" }]]);
		const result = await runFlow(checked(WORK, WORK_SECTIONS), "x", { spawn: fake.spawn });
		assert.deepEqual(!result.ok && [result.error.kind, result.path], ["provider", "work[1]/act"]);
		assert.equal(fake.created.length, 3, "the second item still ran");
	});

	test("with `fail-fast`, skips the items not started, which end `cancelled` in its output", async () => {
		const fake = flowSpawn([[{ submit: { tasks: ["a", "b", "c"] } }], [{ stopReason: "error" }]]);
		const events: SubagentEvent[] = [];
		const result = await runFlow(checked(`${WORK}\n    fail-fast: true\n    on-fail: continue`, WORK_SECTIONS), "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.ok(result.ok);
		const output = endOf(events, "work").output as { item: string; ok: boolean; error: { kind: string; message: string } }[];
		assert.deepEqual(output.map(({ item, ok, error }) => [item, ok, error.kind]), [["a", false, "child"], ["b", false, "cancelled"], ["c", false, "cancelled"]]);
		assert.equal(output[1]?.error.message, "work[2]/act: cancelled: cut by `fail-fast`: work[1]/act failed");
		assert.equal(fake.created.length, 2, "nothing was spawned for a skipped item");
	});

	test("gives each item its own memory scope, closed when the item ends", async () => {
		const flow = checked(
			`  - id: work\n    map: [a, b]\n    do:\n      - id: one\n        agent: scout\n        memory: work\n      - id: two\n        agent: scout\n        memory: work`,
			{ one: "One.", two: "Two." },
		);
		const fake = flowSpawn([[{ text: "a1" }, { text: "a2" }], [{ text: "b1" }, { text: "b2" }]]);
		const result = await runFlow(flow, "x", { spawn: fake.spawn });
		assert.deepEqual(result.ok && result.output, [
			{ item: "a", ok: true, output: "a2" },
			{ item: "b", ok: true, output: "b2" },
		]);
		assert.deepEqual(fake.created.map((session) => [session.prompts.length, session.disposed]), [[2, true], [2, true]]);
	});

	test("lets items running at once share an outer scope's subagent, one turn at a time", async () => {
		const flow = checked(`  - id: work\n    map: [a, b]\n    concurrency: 2\n    do:\n      - id: one\n        agent: scout\n        memory: flow`, { one: "One." });
		const fake = flowSpawn([[{ text: "a", delayMs: 10 }, { text: "b", delayMs: 10 }]]);
		const result = await runFlow(flow, "x", { spawn: fake.spawn });
		assert.ok(result.ok, JSON.stringify(result));
		assert.deepEqual([fake.created.length, fake.created[0]?.prompts.length, fake.created[0]?.disposed], [1, 2, true]);
	});
});
