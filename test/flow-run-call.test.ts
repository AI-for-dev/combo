/**
 * The `flow` node run: its callee's visits under the call's path, what goes
 * in and what comes back, a failure ending the call `child`, the memory
 * scopes that stop at the call and the world that does not, `model:` and
 * `timeout:` read from the callee outward, and the dry run scripting a call
 * whole or walking into it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AskUser } from "../src/ask.ts";
import type { SubagentEvent, VisitEvent } from "../src/events.ts";
import { gitPort } from "../src/git/index.ts";
import { dryRunFlow, runFlow, type CheckedFlow, type RunFlowOptions } from "../src/flow/index.ts";
import type { Attempt } from "../src/flow/run/agent.ts";
import { walkFlow } from "../src/flow/run/flow.ts";
import { NO_JOURNAL } from "../src/flow/run/journal.ts";
import { checkedIn, flowSpawn, flowText, launched, runChecked, visited } from "./fixtures/flow.ts";
import { git, repository } from "./fixtures/repo.ts";

/** The flow `f` calling `g` at `spec`, and nothing else. */
const calling = (g: string) => checkedIn("f", { f: flowText("  - id: spec\n    flow: g\n    input: input"), g });

/** The flow `name` whose nodes are `nodes`, with `sections`. */
const file = (name: string, nodes: string, sections: Record<string, string> = {}, head?: string) => flowText(nodes, sections, head, name);

/** The flow `f` calling `g` at `spec`, then reading its output in `after`. */
const thenAfter = (g: string) => checkedIn("f", { f: flowText("  - id: spec\n    flow: g\n    input: input\n  - id: after\n    agent: synthesiser\n    reads: [spec]", { after: "After." }), g });

/** A callee looping twice on a `look` turn typed `{ ready }`. */
const LOOPING = file("g", "  - id: round\n    loop: look.output.ready\n    max: 2\n    do:\n      - id: look\n        agent: scout\n        reads: [input]\n        output: { ready: boolean }", { look: "Look." });

/** Each visit as it started, with the node address it gave, then as it ended. */
function visits(events: SubagentEvent[]): string[] {
	return events.flatMap((event) => (event.type === "visit_start" ? [`start ${event.path} ${event.node}`] : event.type === "visit_end" ? [`end ${event.path} ${event.ok}`] : []));
}

describe("a call, run", () => {
	test("walks the callee under the call's visit path, and hands back its last root node's output", async () => {
		const events: SubagentEvent[] = [];
		const fake = flowSpawn([[{ text: "", submit: { ready: false } }], [{ text: "", submit: { ready: true } }], [{ text: "done" }]]);
		const result = await runChecked(thenAfter(LOOPING), "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.ok(result.ok, JSON.stringify(result));
		assert.deepEqual(visits(events), [
			"start spec spec",
			"start spec/round spec/round",
			"start spec/round#1/look spec/round/look",
			"end spec/round#1/look true",
			"start spec/round#2/look spec/round/look",
			"end spec/round#2/look true",
			"end spec/round true",
			"end spec true",
			"start after after",
			"end after true",
		]);
		const spec = events.find((event): event is VisitEvent => event.type === "visit_end" && event.path === "spec");
		assert.deepEqual(spec?.type === "visit_end" && (spec.output as { converged: boolean }).converged, true);
		assert.match(fake.created[2]?.prompts[0] ?? "", /## spec\n\n```json\n\{\n {2}"converged": true/);
	});

	test("hands a typed value to a text input as JSON", async () => {
		const g = file("g", "  - id: look\n    agent: scout\n    reads: [input]", { look: "Look." });
		const f = flowText("  - id: plan\n    agent: planner\n    output: { task: string }\n  - id: spec\n    flow: g\n    input: plan.output", { plan: "Plan." });
		const fake = flowSpawn([[{ text: "", submit: { task: "cache" } }], [{ text: "seen" }]]);
		const result = await runChecked(checkedIn("f", { f, g }), "x", { spawn: fake.spawn });
		assert.deepEqual(result.ok && result.output, "seen");
		assert.match(fake.created[1]?.prompts[0] ?? "", /## input\n\n\{\n {2}"task": "cache"\n\}/);
	});

	test("a failed callee ends the call `child`, naming the visit inside it; `on-fail: continue` absorbs it", async () => {
		const g = file("g", "  - id: look\n    agent: scout", { look: "Look." });
		const events: SubagentEvent[] = [];
		const failed = await runChecked(calling(g), "x", { spawn: flowSpawn([[{ stopReason: "error" }]]).spawn, onEvent: (event) => events.push(event) });
		assert.deepEqual(!failed.ok && [failed.error, failed.path], [{ kind: "provider", message: "boom" }, "spec/look"]);
		const spec = events.find((event) => event.type === "visit_end" && event.path === "spec");
		assert.deepEqual(spec?.type === "visit_end" && spec.error, { kind: "child", message: "spec/look: provider: boom" });
		const fake = flowSpawn([[{ stopReason: "error" }], [{ text: "went on" }]]);
		const absorbed = await runChecked(checkedIn("f", { f: flowText("  - id: spec\n    flow: g\n    input: input\n    on-fail: continue\n  - id: after\n    agent: synthesiser\n    reads: [spec]", { after: "After." }), g }), "x", { spawn: fake.spawn });
		assert.deepEqual(absorbed.ok && absorbed.output, "went on");
		assert.match(fake.created[1]?.prompts[0] ?? "", /"kind": "child"/);
	});
});

describe("the boundary", () => {
	test("an agent named on both sides with `memory: flow` is two subagents, the callee's closed when the call ends", async () => {
		const g = file("g", "  - id: inner\n    agent: scout\n    memory: flow", { inner: "Inner." });
		const f = flowText("  - id: first\n    agent: scout\n    memory: flow\n  - id: spec\n    flow: g\n    input: input\n  - id: last\n    agent: scout\n    memory: flow", { first: "First.", last: "Last." });
		let closedBeforeLast: boolean | undefined;
		const fake = flowSpawn([[{ text: "1" }, { text: "3" }], [{ text: "2" }]]);
		const onEvent: RunFlowOptions["onEvent"] = (event) => {
			if (event.type === "visit_start" && event.path === "last") closedBeforeLast = fake.created[1]?.disposed;
		};
		const result = await runChecked(checkedIn("f", { f, g }), "x", { spawn: fake.spawn, onEvent });
		assert.deepEqual(result.ok && result.output, "3");
		assert.deepEqual([fake.created.length, fake.created[0]?.prompts.length, fake.created[1]?.prompts.length, closedBeforeLast], [2, 2, 1, true]);
	});

	test("the callee's questions join the run's one queue, each card naming its visit", async () => {
		const g = file("g", '  - id: q\n    ask: "Go?"\n    confirm: true');
		const f = flowText("  - id: both\n    parallel:\n      a:\n        - id: one\n          flow: g\n          input: input\n      b:\n        - id: two\n          flow: g\n          input: input");
		const cards: string[] = [];
		let open = 0;
		let most = 0;
		const ask: AskUser = async (_question, asking) => {
			cards.push(asking?.visit ?? "");
			most = Math.max(most, ++open);
			await new Promise((resolve) => setTimeout(resolve, 10));
			open--;
			return { question: "", answer: "yes", custom: false };
		};
		const result = await runFlow(await launched(checkedIn("f", { f, g }), { ports: { ask }, somebodyThere: true }), "x");
		assert.ok(result.ok, JSON.stringify(result));
		assert.deepEqual([cards.sort(), most], [["both/a/one/q", "both/b/two/q"], 1]);
	});

	test("the callee commits on the run's one branch", async () => {
		const cwd = repository();
		const g = file("g", "  - id: m\n    agent: scout\n  - id: c\n    commit: m", { m: "Write." });
		const f = flowText("  - id: m0\n    agent: scout\n  - id: c0\n    commit: m0\n  - id: spec\n    flow: g\n    input: input", { m0: "Write." });
		const events: VisitEvent[] = [];
		const run = await launched(checkedIn("f", { f, g }), { cwd, ports: { git: gitPort() } });
		const result = await runFlow(run, "work", { spawn: flowSpawn([[{ text: "One" }], [{ text: "Two" }]]).spawn, onEvent: (event) => events.push(event as VisitEvent) });
		assert.ok(result.ok, JSON.stringify(result));
		const branches = events.flatMap((event) => (event.type === "visit_end" && (event.path === "c0" || event.path === "spec/c") ? [(event.output as { branch: string }).branch] : []));
		assert.deepEqual([branches, git(cwd, "branch", "--list", "combo/*").trim()], [["combo/work", "combo/work"], "* combo/work"]);
	});
});

describe("`model:` and `timeout:` through calls", () => {
	const h = file("h", "  - id: last\n    agent: reviewer", { last: "Last." });
	const g = (head: string) => file("g", "  - id: look\n    agent: planner\n  - id: deeper\n    flow: h\n    input: input", { look: "Look." }, `input: string${head}`);
	const f = (inner: string, outer: string) => checkedIn("f", { f: flowText("  - id: first\n    agent: scout\n  - id: spec\n    flow: g\n    input: input", { first: "First." }, `input: string${outer}`), g: g(inner), h });

	test("a model is the run's, else the callee's, else its caller's, outward", async () => {
		const models = async (checked: CheckedFlow, model?: string) => {
			const fake = flowSpawn([[{ text: "" }], [{ text: "" }], [{ text: "" }]]);
			await runChecked(checked, "x", { spawn: fake.spawn, model });
			return fake.requested.map((one) => one.options.model);
		};
		assert.deepEqual(await models(f("\nmodel: callee/m", "\nmodel: caller/m")), ["caller/m", "callee/m", "callee/m"]);
		assert.deepEqual(await models(f("", "\nmodel: caller/m")), ["caller/m", "caller/m", "caller/m"]);
		assert.deepEqual(await models(f("\nmodel: callee/m", "\nmodel: caller/m"), "run/m"), ["run/m", "run/m", "run/m"]);
	});

	test("a turn's bound is the run's, else the node's, else the callee's, else its caller's, outward", async () => {
		const bounds = async (checked: CheckedFlow, timeoutMs?: number) => {
			const attempts: Attempt[] = [];
			const world = {
				deadline: (attempt: Attempt) => (attempts.push(attempt), new AbortController().signal),
				check: async () => ({ ok: false as const, kind: "unavailable" as const, message: "" }),
				commit: async () => ({ ok: false as const, kind: "unavailable" as const, message: "" }),
				diff: async () => ({ ok: true as const, value: "" }),
				ask: async () => ({ missed: "nobody" as const }),
				journal: NO_JOURNAL,
			};
			await walkFlow(checked, "x", { spawn: flowSpawn([[{ text: "" }], [{ text: "" }], [{ text: "" }]]).spawn, timeoutMs }, world);
			return attempts.map(({ at, ms }) => `${at} ${ms}`);
		};
		assert.deepEqual(await bounds(f("\ntimeout: 2m", "\ntimeout: 1h")), ["first 3600000", "spec/look 120000", "spec/deeper/last 120000"]);
		assert.deepEqual(await bounds(f("", "\ntimeout: 1h")), ["first 3600000", "spec/look 3600000", "spec/deeper/last 3600000"]);
		assert.deepEqual(await bounds(f("\ntimeout: 2m", ""), 5), ["first 5", "spec/look 5", "spec/deeper/last 5"]);
	});
});

describe("a call, dry run", () => {
	const withAfter = thenAfter(LOOPING);
	const WHOLE = { converged: true, stop: "until", iterations: 1, last: { look: { ok: true, output: { ready: true } } } };

	test("is scripted whole by a key on its address, the callee not walked", async () => {
		const run = await dryRunFlow(withAfter, "x", { spec: WHOLE, after: "done" });
		assert.deepEqual(visited(run).map(({ path }) => path), ["spec", "after"]);
		const failed = await dryRunFlow(withAfter, "x", { spec: { fail: "child" } });
		assert.deepEqual(!failed.ok && "error" in failed && [failed.error.kind, failed.path], ["child", "spec"]);
	});

	test("is walked into by keys under it, by address through the call or by exact visit path", async () => {
		const run = await dryRunFlow(withAfter, "x", { "spec/round/look": { ready: false }, "spec/round#2/look": { ready: true }, after: "done" });
		assert.deepEqual(visited(run).map(({ path, ok }) => `${path} ${ok}`), ["spec/round#1/look true", "spec/round#2/look true", "spec/round true", "spec true", "after true"]);
		const hole = await dryRunFlow(withAfter, "x", { after: "done" });
		assert.deepEqual(!hole.ok && "unscripted" in hole && hole.unscripted, "spec/round#1/look");
	});

	test("refuses a script that does both, or answers the call off its callee's output", async () => {
		const both = await dryRunFlow(withAfter, "x", { spec: WHOLE, "spec/round/look": { ready: true } });
		assert.deepEqual(!both.ok && "faults" in both && both.faults.map(({ code, at }) => `${code} ${at}`), ["answer-flow-overlap spec/round/look"]);
		const off = await dryRunFlow(withAfter, "x", { spec: "done", "spec/round#3/look": { ready: true }, "spec/nothing": "x", spec2: { fail: "provider" } });
		assert.deepEqual(!off.ok && "faults" in off && off.faults.map(({ code, at }) => `${code} ${at}`), ["answer-off-schema spec", "answer-past-max spec/round#3/look", "answer-unknown-node spec/nothing", "answer-unknown-node spec2"]);
	});
});
