/**
 * The loop at run time: its iterations and the paths they give, `until`,
 * `give-up` and the cap, `previous`, `carry`, the ledger with the `verdict:`
 * nodes writing to it, and the memory scope it keeps across iterations.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SubagentEvent } from "../src/events.ts";
import { runFlow } from "../src/flow/index.ts";
import { IN_THE_LANGUAGE_OF_THE_WORK } from "../src/language.ts";
import { stopSwitch } from "../src/stop.ts";
import { checked, flowSpawn } from "./fixtures/flow.ts";

function endOf(events: SubagentEvent[], path: string) {
	const found = events.find((event) => event.type === "visit_end" && event.path === path);
	assert.ok(found?.type === "visit_end", `no visit ended at ${path}`);
	return found;
}

/** A loop whose `judge` decides, `head` written under its `max:`. */
function review(head = "", code = "        reads: [review.previous.judge]") {
	return checked(
		`  - id: review
    loop: judge.output.fine
    max: 3${head}
    do:
      - id: code
        agent: scout
${code}
      - id: judge
        agent: reviewer
        output: { fine: boolean, hopeless: boolean }`,
		{ code: "Code.", judge: "Judge." },
	);
}

const judged = (fine: boolean, hopeless = false) => [{ submit: { fine, hopeless } }];

/** The first turn each subagent of `agent` was asked, in spawn order. */
function firstTurns(fake: ReturnType<typeof flowSpawn>, agent: string): (string | undefined)[] {
	return fake.created.filter((_, i) => fake.requested[i]?.agent.name === agent).map((session) => session.prompts[0]);
}

describe("a loop", () => {
	test("runs its body until its condition holds, numbering iterations from 1", async () => {
		const fake = flowSpawn({ scout: [[{ text: "v1" }], [{ text: "v2" }]], reviewer: [judged(false), judged(true)] });
		const events: SubagentEvent[] = [];
		const result = await runFlow(review(), "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		const last = { code: { ok: true, output: "v2" }, judge: { ok: true, output: { fine: true, hopeless: false } } };
		assert.deepEqual(result.ok && result.output, { converged: true, stop: "until", iterations: 2, last });
		const paths = events.flatMap((event) => (event.type === "visit_end" ? [event.path] : []));
		assert.deepEqual(paths, ["review#1/code", "review#1/judge", "review#2/code", "review#2/judge", "review"]);
		assert.equal(endOf(events, "review").converged, true);
	});

	test("hands an iteration the one before it through `previous`, absent on the first", async () => {
		const fake = flowSpawn({ scout: [[{ text: "v1" }], [{ text: "v2" }]], reviewer: [judged(false), judged(true)] });
		await runFlow(review(), "x", { spawn: fake.spawn });
		const [first, second] = firstTurns(fake, "scout");
		assert.equal(first, `Code.\n\n${IN_THE_LANGUAGE_OF_THE_WORK}`, "no section on a first iteration");
		assert.match(second ?? "", /^Code\.\n\n## review\.previous\.judge\n\n```json\n\{\n {2}"ok": true,\n {2}"output": \{\n {4}"fine": false/);
	});

	test("fails `unconverged` at its cap, or ends `ok: true, converged: false` under `on-fail: continue`", async () => {
		const turns = { scout: [[{ text: "1" }], [{ text: "2" }], [{ text: "3" }]], reviewer: [judged(false), judged(false), judged(false)] };
		const capped = await runFlow(review(), "x", { spawn: flowSpawn(turns).spawn });
		assert.deepEqual(!capped.ok && [capped.error, capped.path], [{ kind: "unconverged", message: "reached `max: 3` before `judge.output.fine` held" }, "review"]);
		const events: SubagentEvent[] = [];
		const kept = await runFlow(review("\n    on-fail: continue"), "x", { spawn: flowSpawn(turns).spawn, onEvent: (event) => events.push(event) });
		assert.deepEqual(kept.ok && kept.output && [(kept.output as { converged: boolean }).converged, (kept.output as { stop: string }).stop], [false, "cap"]);
		assert.equal(endOf(events, "review").converged, false);
	});

	test("gives up when `give-up:` holds, not converged either", async () => {
		const fake = flowSpawn({ scout: [[{ text: "1" }]], reviewer: [judged(false, true)] });
		const result = await runFlow(review("\n    give-up: judge.output.hopeless"), "x", { spawn: fake.spawn });
		assert.deepEqual(!result.ok && result.error, { kind: "unconverged", message: "gave up after 1 iteration before `judge.output.fine` held" });
	});

	test("ends at once on a body node that fails, its condition never read", async () => {
		const fake = flowSpawn({ scout: [[{ stopReason: "error" }]] });
		const result = await runFlow(review(), "x", { spawn: fake.spawn });
		assert.deepEqual(!result.ok && [result.error.kind, result.path], ["provider", "review#1/code"]);
		assert.equal(fake.created.length, 1);
	});

	test("carries `first` into its first iteration and `next` into each after", async () => {
		const flow = checked(
			`  - id: plan
    agent: planner
    output: { todo: [string] }
  - id: fix
    loop: size(judge.output.todo) == 0
    max: 3
    carry: { first: plan.output.todo, next: judge.output.todo }
    do:
      - id: judge
        agent: reviewer
        reads: [fix.carry]
        output: { todo: [string] }`,
			{ plan: "Plan.", judge: "Judge." },
		);
		const fake = flowSpawn([[{ submit: { todo: ["a", "b"] } }], [{ submit: { todo: ["b"] } }], [{ submit: { todo: [] } }]]);
		const result = await runFlow(flow, "x", { spawn: fake.spawn });
		assert.deepEqual(result.ok && (result.output as { iterations: number }).iterations, 2);
		assert.match(fake.created[1]?.prompts[0] ?? "", /## fix\.carry\n\n```json\n\[\n {2}"a",\n {2}"b"\n\]/);
		assert.match(fake.created[2]?.prompts[0] ?? "", /## fix\.carry\n\n```json\n\[\n {2}"b"\n\]/);
	});

	test("keeps one memory scope across its iterations, closed when it ends, a stop included", async () => {
		const code = "        memory: review";
		const fake = flowSpawn({ scout: [[{ text: "v1" }, { text: "v2" }]], reviewer: [judged(false), judged(true)] });
		const result = await runFlow(review("", code), "x", { spawn: fake.spawn });
		assert.ok(result.ok);
		const scout = fake.created[0];
		assert.deepEqual([scout?.prompts.length, scout?.disposed], [2, true]);

		const hanging = flowSpawn({ scout: [[{ text: "v1" }, { delayMs: 5000 }]], reviewer: [judged(false)] });
		const switcher = stopSwitch({ spawn: hanging.spawn });
		const running = runFlow(review("", code), "x", { spawn: switcher.spawn, signal: switcher.signal });
		setTimeout(() => switcher.all(), 30);
		const stopped = await running;
		assert.deepEqual(!stopped.ok && [stopped.error.kind, stopped.path], ["stopped", "review#2/code"]);
		assert.ok(hanging.created.every((session) => session.disposed));
	});
});

describe("a ledger and its verdicts", () => {
	const FLOW = `  - id: review
    loop: judge.output.approved
    max: 3
    ledger: review
    do:
      - id: code
        agent: scout
        reads: [review.ledger]
      - id: judge
        agent: reviewer
        verdict: review`;
	const SECTIONS = { code: "Code.", judge: "Judge." };

	test("a verdict raises and closes obligations, and approves only once nothing is left open", async () => {
		const yes = { approved: true };
		const fake = flowSpawn({
			scout: [[{ text: "v1" }], [{ text: "v2" }], [{ text: "v3" }]],
			reviewer: [[{ verdict: { approved: false, raised: ["add a test"] } }], [{ verdict: yes }], [{ verdict: { ...yes, resolved: [{ id: "o1", how: "addressed" }] } }]],
		});
		const events: SubagentEvent[] = [];
		const result = await runFlow(checked(FLOW, SECTIONS), "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.deepEqual(result.ok && (result.output as { iterations: number }).iterations, 3);
		const decided = ["review#1/judge", "review#2/judge", "review#3/judge"].map((path) => endOf(events, path).output);
		assert.deepEqual(decided, [{ approved: false }, { approved: false }, { approved: true }], "a yes with `o1` still open is not an approval");

		const [coder1, coder2] = firstTurns(fake, "scout");
		const [judge1, judge2] = firstTurns(fake, "reviewer");
		assert.match(coder1 ?? "", /## review\.ledger\n\n```json\n\[\]\n```/);
		assert.match(coder2 ?? "", /"id": "o1",\n {4}"text": "add a test"/);
		assert.match(judge1 ?? "", /^Judge\.\n\nEnd by calling the `verdict` tool/);
		assert.match(judge2 ?? "", /^Judge\.\n\nStill open, from your earlier rounds:\no1: add a test\n\nEnd by calling the `verdict` tool/);
		const tools = fake.requested.slice(0, 2).map(({ agent }) => agent.tools);
		assert.deepEqual(tools, [undefined, ["read", "grep", "find", "ls", "verdict"]]);
	});

	test("a verdict turn that calls nothing fails with `schema`", async () => {
		const fake = flowSpawn({ scout: [[{ text: "v1" }]], reviewer: [[{ text: "Looks good to me." }]] });
		const result = await runFlow(checked(FLOW, SECTIONS), "x", { spawn: fake.spawn });
		assert.deepEqual(!result.ok && [result.error, result.path], [{ kind: "schema", message: "the turn ended with no `verdict` call" }, "review#1/judge"]);
	});

	test("a map keeps one ledger per item", async () => {
		const flow = checked(
			`  - id: work
    map: [a, b]
    ledger: work
    do:
      - id: judge
        agent: reviewer
        verdict: work
      - id: after
        agent: scout
        reads: [work.ledger]`,
			{ judge: "Judge.", after: "After." },
		);
		const fake = flowSpawn({ reviewer: [[{ verdict: { approved: false, raised: ["only a"] } }], [{ verdict: { approved: true } }]], scout: [[{ text: "a" }], [{ text: "b" }]] });
		await runFlow(flow, "x", { spawn: fake.spawn });
		const [afterA, afterB] = firstTurns(fake, "scout");
		assert.match(afterA ?? "", /"text": "only a"/);
		assert.match(afterB ?? "", /## work\.ledger\n\n```json\n\[\]\n```/);
	});
});
