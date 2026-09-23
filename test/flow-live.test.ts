/**
 * The live view of a flow run: the plan folded with the journal and the
 * event stream of a dry run, cut at the event a frame would be drawn on.
 * The fold is pure, so each frame is asserted whole, with every visit's time
 * zeroed: a dry run's clock is the only thing in it that moves.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SubagentEvent } from "../src/events.ts";
import { dryRunFlow, livePlan, planOf, showLive, showPlan, showSummary, type Answers, type CheckedFlow, type DryRun, type JournalEntry } from "../src/flow/index.ts";
import { checked, checkedIn, flowText } from "./fixtures/flow.ts";

/** A loop around a `map`, a `parallel` whose one branch asks, a `choice` and a verdict, then one agent. */
const BLOCKS = checked(
	`  - id: deliver
    loop: audit.output.approved
    max: 2
    ledger: deliver
    do:
      - id: work
        map: [a, b]
        do:
          - id: code
            agent: scout
      - id: both
        parallel:
          left:
            - id: look
              agent: scout
          right:
            - id: sure
              ask: "Go on?"
              confirm: true
      - id: gate
        choice:
          - when: both.output.left.ok
            do:
              - id: fine
                agent: scout
        default: []
      - id: audit
        agent: reviewer
        verdict: deliver
  - id: after
    agent: synthesiser`,
	{ code: "Code.", look: "Look.", audit: "Audit.", fine: "Fine.", after: "After." },
);

const BLOCKS_ANSWERS: Answers = {
	"deliver/work/code": "coded",
	"deliver/both/look": "seen",
	"deliver/both/sure": { yes: true },
	"deliver/gate/fine": "fine",
	"deliver/audit": [{ approved: false, raised: ["more"] }, { approved: true, resolved: [{ id: "o1", how: "addressed" }] }],
	after: "done",
};

/** A dry run of `flow`, its journal and its events, every visit's time zeroed. */
async function recorded(flow: CheckedFlow, answers: Answers, from?: readonly JournalEntry[]) {
	const events: SubagentEvent[] = [];
	const run = await dryRunFlow(flow, "x", answers, { from, onEvent: (event) => events.push(event) });
	assert.ok("journal" in run && !("unscripted" in run), JSON.stringify(run));
	return { run, journal: still(run.journal), events: still(events) };
}

/** `entries` with each visit's and each run end's time at zero. */
function still<T extends SubagentEvent | JournalEntry>(entries: readonly T[]): T[] {
	return entries.map((entry) => {
		if (entry.type === "visit_end") return { ...entry, wallMs: 0, usage: { ...entry.usage, wallMs: 0 } };
		if (entry.type === "run_end") return { ...entry, usage: { ...entry.usage, wallMs: 0 } };
		return entry;
	});
}

/** `events` up to the start of the visit `path`, which is running. */
function atStart(events: readonly SubagentEvent[], path: string): SubagentEvent[] {
	const at = events.findIndex((event) => event.type === "visit_start" && event.path === path);
	assert.ok(at >= 0, `no visit ${path}`);
	return events.slice(0, at + 1);
}

/** The frame of `flow` as text lines, wide enough to cut nothing. */
function frame(flow: CheckedFlow, journal: readonly JournalEntry[], events: readonly SubagentEvent[]): string[] {
	return showLive(livePlan(flow, journal, events), 400).split("\n");
}

describe("the live view", () => {
	test("before the first visit, is the plan", () => {
		const flow = checked("  - id: plan\n    agent: planner\n  - id: work\n    map: [a]\n    do:\n      - id: code\n        agent: scout", { plan: "P.", code: "C." });
		assert.deepEqual(frame(flow, [], []).slice(1), showPlan(planOf(flow)).split("\n").slice(1));
		assert.equal(frame(flow, [], [])[0], "○ f · 0 visits · 0s · ↑0 ↓0");
	});

	test("mid-run, expands what runs and folds what ended: iterations, items and branches", async () => {
		const { events } = await recorded(BLOCKS, BLOCKS_ANSWERS);
		assert.deepEqual(frame(BLOCKS, [], atStart(events, "deliver#2/work[2]/code")), [
			"● f · 10 visits · 0s · ↑0 ↓0",
			"● deliver · #2 of 2",
			"  ✓ deliver#1 · 0s · ↑0 ↓0",
			"  ● deliver#2",
			"    ● deliver#2/work · 1/2",
			"      ✓ deliver#2/work[1] · 0s · ↑0 ↓0",
			"      ● deliver#2/work[2]",
			"        ● deliver#2/work[2]/code",
			"    ○ deliver#2/both · parallel · ≤ 2 turns · ≤ 1h + a person's answer",
			"      ○ deliver#2/both/left",
			"        ○ deliver#2/both/left/look · agent scout (agents/scout.md) · timeout 30m by default · ≤ 2 turns · ≤ 1h",
			"      ○ deliver#2/both/right",
			`        ○ deliver#2/both/right/sure · ask "Go on?" · confirm · a person's answer`,
			"    ○ deliver#2/gate · choice of 1 case · ≤ 2 turns · ≤ 1h",
			"      ○ case 1, default",
			"    ○ deliver#2/audit · agent reviewer (agents/reviewer.md) · verdict to deliver · timeout 30m by default · ≤ 2 turns · ≤ 1h",
			"○ after · agent synthesiser (agents/synthesiser.md) · timeout 30m by default · ≤ 1 turn · ≤ 30m",
		]);
	});

	test("reads a parallel as its branches ended, an ask waiting as blocked, and a subagent on its visit", async () => {
		const { events } = await recorded(BLOCKS, BLOCKS_ANSWERS);
		const asking = atStart(events, "deliver#1/both/right/sure");
		assert.deepEqual(frame(BLOCKS, [], asking).slice(4, 9), [
			"    ● deliver#1/both · 0/2",
			"      ● deliver#1/both/left",
			"        ● deliver#1/both/left/look",
			"      ● deliver#1/both/right",
			`        ● deliver#1/both/right/sure · ask "Go on?"`,
		]);
		const sure = livePlan(BLOCKS, [], asking).lines[0]?.lines[0]?.lines[1]?.lines[1]?.lines[0];
		assert.deepEqual([sure?.path, sure?.state], ["deliver#1/both/right/sure", "blocked"]);
		const spawn = events.find((event) => event.type === "spawn" && event.visit === "deliver#1/work[1]/code");
		const spawned = events.slice(0, events.indexOf(spawn as SubagentEvent) + 1);
		assert.ok(frame(BLOCKS, [], spawned).includes(`        ● deliver#1/work[1]/code · ${(spawn as { id: string }).id}`));
	});

	test("folds a choice's cases before it decides, and the ones it did not take after", async () => {
		const { events } = await recorded(BLOCKS, BLOCKS_ANSWERS);
		assert.deepEqual(frame(BLOCKS, [], atStart(events, "deliver#1/gate/fine")).slice(3, 9), [
			"    ✓ deliver#1/work · 2 items · 0s · ↑0 ↓0",
			"    ✓ deliver#1/both · 2 branches · 0s · ↑0 ↓0",
			"    ● deliver#1/gate",
			"      ● case 1 · when both.output.left.ok",
			"        ● deliver#1/gate/fine",
			"      ○ not taken: default",
		]);
	});

	test("expands a running sub-flow's plan under its call, and folds it once it ended", async () => {
		const g = flowText("  - id: look\n    agent: scout\n  - id: more\n    agent: scout", { look: "L.", more: "M." }, "input: string", "g");
		const calling = checkedIn("f", { f: flowText("  - id: spec\n    flow: g\n    input: input\n  - id: after\n    agent: synthesiser", { after: "After." }), g });
		const { events } = await recorded(calling, { "spec/look": "l", "spec/more": "m", after: "a" });
		assert.deepEqual(frame(calling, [], atStart(events, "spec/look")).slice(1, 4), [
			"● spec",
			"  ● spec/look",
			"  ○ spec/more · agent scout (agents/scout.md) · timeout 30m by default · ≤ 1 turn · ≤ 30m",
		]);
		assert.deepEqual(frame(calling, [], atStart(events, "after")), ["● f · 3 visits · 0s · ↑0 ↓0", "✓ spec · 0s · ↑0 ↓0", "● after"]);
	});

	test("once over, is one line per root node, and the journal alone draws the same frame", async () => {
		const { journal, events } = await recorded(BLOCKS, BLOCKS_ANSWERS);
		const last = ["✓ f · 20 visits · 0s · ↑0 ↓0", "✓ deliver · 2 iterations · 0s · ↑0 ↓0", "✓ after · synthesiser · 0s · ↑0 ↓0"];
		assert.deepEqual(frame(BLOCKS, [], events), last);
		assert.deepEqual(frame(BLOCKS, journal, []), last);
		assert.equal(showSummary(livePlan(BLOCKS, journal, []), 400), last[0]);
	});

	test("counts every failed visit, absorbed ones included, names a loop that did not converge, and marks what was never reached", async () => {
		const flow = checked(
			"  - id: look\n    agent: scout\n    on-fail: continue\n  - id: fix\n    loop: audit.output.approved\n    max: 1\n    on-fail: continue\n    do:\n      - id: audit\n        agent: reviewer\n        output: { approved: boolean }\n  - id: plan\n    agent: planner\n  - id: after\n    agent: synthesiser",
			{ look: "L.", audit: "A.", plan: "P.", after: "A." },
		);
		const { events } = await recorded(flow, { look: { fail: "provider" }, "fix/audit": { approved: false }, plan: { fail: "provider" } });
		assert.deepEqual(frame(flow, [], events), [
			"✗ f · 4 visits · 2 failed · fix not converged · 0s · ↑0 ↓0",
			"✗ look · provider: scripted provider failure · 0s · ↑0 ↓0",
			"✓ fix · 1 iteration · not converged · 0s · ↑0 ↓0",
			"✗ plan · provider: scripted provider failure · 0s · ↑0 ↓0",
			"– after",
		]);
	});

	describe("a resumed run", () => {
		const LOOP = checked(
			"  - id: plan\n    agent: planner\n  - id: fix\n    loop: audit.output.approved\n    max: 3\n    do:\n      - id: work\n        agent: scout\n      - id: audit\n        agent: reviewer\n        output: { approved: boolean }",
			{ plan: "P.", work: "W.", audit: "A." },
		);

		/** A run of `LOOP` killed before `fix#2/work` ended, each visit it ended costing 1k tokens in and 100 out, then its resume. */
		async function killedAndResumed() {
			const whole = await recorded(LOOP, { plan: "p", "fix/work": "w", "fix/audit": [{ approved: false }, { approved: true }] });
			const cut = whole.journal.findIndex((entry) => entry.type === "visit_end" && entry.path === "fix#2/work");
			const from = whole.journal.slice(0, cut).map((entry) => (entry.type === "visit_end" ? { ...entry, usage: { ...entry.usage, input: 1000, output: 100 } } : entry));
			return { from, resumed: await recorded(LOOP, { "fix/work": "w", "fix#2/audit": { approved: true } }, from) };
		}

		test("draws what the killed life ended like any ended visit, and what it left open as not run yet", async () => {
			const { from } = await killedAndResumed();
			assert.deepEqual(frame(LOOP, from, []), ["○ f · 3 visits · 0s · ↑3k ↓300", "✓ plan · planner · 0s · ↑1k ↓100", "○ fix · #1 of 3", "  ✓ fix#1 · 0s · ↑2k ↓200"]);
		});

		test("says in its summary how many lives it had, which were partial, where it picked up, and what they all cost", async () => {
			const { from, resumed } = await killedAndResumed();
			assert.deepEqual(frame(LOOP, from, atStart(resumed.events, "fix#2/audit")), [
				"● f · 4 visits · 0s · ↑3k ↓300 · 2 lives (1 partial) · resumed from fix#2/work",
				"✓ plan · planner · 0s · ↑1k ↓100",
				"● fix · #2 of 3",
				"  ✓ fix#1 · 0s · ↑2k ↓200",
				"  ● fix#2",
				"    ✓ fix#2/work · scout · 0s · ↑0 ↓0",
				"    ● fix#2/audit",
			]);
			assert.equal(frame(LOOP, from, resumed.events)[0], "✓ f · 6 visits · 0s · ↑3k ↓300 · 2 lives (1 partial) · resumed from fix#2/work");
		});

		test("tells the killed life from the next by its journal alone, each opening with its `life_start`", async () => {
			const { resumed } = await killedAndResumed();
			assert.equal(frame(LOOP, resumed.journal, [])[0], "✓ f · 6 visits · 0s · ↑3k ↓300 · 2 lives (1 partial) · resumed from fix#2/work");
			assert.equal(frame(LOOP, resumed.journal.slice(0, -1), [])[0], "✓ f · 6 visits · 0s · ↑3k ↓300 · 2 lives (2 partial) · resumed from fix#2/work");
		});
	});

	test("is the same frame for the same journal and events, at every event of a run", async () => {
		const { events } = await recorded(BLOCKS, BLOCKS_ANSWERS);
		for (let at = 0; at <= events.length; at++) assert.deepEqual(livePlan(BLOCKS, [], events.slice(0, at)), livePlan(BLOCKS, [], events.slice(0, at)));
	});

	test("cuts each line to the width it is given, indent kept", async () => {
		const { events } = await recorded(BLOCKS, BLOCKS_ANSWERS);
		const lines = showLive(livePlan(BLOCKS, [], atStart(events, "deliver#2/work[2]/code")), 25).split("\n");
		assert.ok(lines.every((line) => line.length <= 25));
		assert.deepEqual(lines.slice(6, 8), ["      ● deliver#2/work[2]", "        ● deliver#2/work…"]);
	});

	test("is an observer: a view that throws on every event leaves the run and its journal as they were", async () => {
		const events: SubagentEvent[] = [];
		const watched = await dryRunFlow(BLOCKS, "x", BLOCKS_ANSWERS, {
			onEvent: (event) => {
				events.push(event);
				showLive(livePlan(BLOCKS, [], events), 80);
				throw new Error("a broken view");
			},
		});
		const alone = await dryRunFlow(BLOCKS, "x", BLOCKS_ANSWERS);
		// A clock and the process's subagent counter are all that differ between two runs.
		const facts = (run: DryRun) => ("journal" in run ? still(run.journal) : []).map((entry) => ({ ...entry, usage: undefined, wallMs: undefined, startedAt: undefined, subagent: undefined }));
		assert.equal(watched.ok, alone.ok);
		assert.deepEqual(facts(watched), facts(alone));
	});
});
