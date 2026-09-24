/**
 * Where a journal picks up, tried offline: a dry run given `from:` a journal
 * cut where a run would have been killed resumes through the same
 * `resumePoint` a real resume takes, and runs only what did not end. A
 * visit the resumed script leaves out would stop the run `unscripted`, so an
 * answer missing from it proves the visit was not asked again.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dryRunFlow, resumePoint, type Answers, type CheckedFlow, type DryRun, type JournalEntry } from "../src/flow/index.ts";
import { checked, checkedIn, flowText } from "./fixtures/flow.ts";

/** The journal of `run`, which ran to a flow outcome. */
function journalOf(run: DryRun): readonly JournalEntry[] {
	assert.ok("journal" in run && !("unscripted" in run), JSON.stringify(run));
	return run.journal;
}

/** `journal` as a kill just before the visit `path` ended would have left it. */
function killedBefore(journal: readonly JournalEntry[], path: string): JournalEntry[] {
	const at = journal.findIndex((entry) => entry.type === "visit_end" && entry.path === path);
	assert.ok(at > 0, `no visit ${path}`);
	return journal.slice(0, at);
}

/** The facts a resume of `from` added after its `life_start`, as `type path`. */
function added(run: DryRun, from: readonly JournalEntry[]): string[] {
	const [start, ...facts] = journalOf(run).slice(from.length);
	assert.equal(start?.type, "life_start");
	return facts.map((entry) => ("path" in entry && entry.path !== undefined ? `${entry.type} ${entry.path}` : "ledger" in entry ? `${entry.type} ${entry.ledger}` : entry.type));
}

/** Runs `flow` on `answers`, and resumes what a kill before `path` left with `again`. */
async function killedAndResumed(flow: CheckedFlow, answers: Answers, path: string, again: Answers) {
	const whole = await dryRunFlow(flow, "x", answers);
	const from = killedBefore(journalOf(whole), path);
	const point = resumePoint(flow, from);
	const resumed = await dryRunFlow(flow, "x", again, { from });
	assert.ok(resumed.ok, JSON.stringify(resumed));
	return { whole, from, point, resumed };
}

describe("a resume after a kill", () => {
	test("inside a loop, carries on its iteration with its carry and its ledger restored", async () => {
		const flow = checked(
			`  - id: plan
    agent: planner
    output: { todo: [string] }
  - id: fix
    loop: audit.output.approved
    max: 3
    ledger: fix
    carry: { first: plan.output.todo, next: plan.output.todo }
    do:
      - id: work
        agent: scout
      - id: audit
        agent: reviewer
        verdict: fix`,
			{ plan: "Plan.", work: "Work.", audit: "Audit." },
		);
		const approve = { approved: true, resolved: [{ id: "o1", how: "addressed" }] };
		const { whole, from, point, resumed } = await killedAndResumed(
			flow,
			{ plan: { todo: ["a"] }, "fix/work": "done", "fix/audit": [{ approved: false, raised: ["more"] }, approve] },
			"fix#2/work",
			{ "fix/work": "done", "fix#2/audit": approve },
		);
		assert.deepEqual(point.ok && point.from, "fix#2/work");
		// The carry of `fix#2` and the plan are not written again; `o1` is closed in the restored ledger.
		assert.deepEqual(added(resumed, from), ["visit_end fix#2/work", "obligation_closed fix", "visit_end fix#2/audit", "visit_end fix", "run_end"]);
		assert.deepEqual(resumed.ok && resumed.output, whole.ok && whole.output);
	});

	test("inside a map, runs the items that did not end over the list it froze", async () => {
		const flow = checked("  - id: plan\n    agent: planner\n    output: { todo: [string] }\n  - id: work\n    map-from: plan.output.todo\n    max: 3\n    concurrency: 1\n    do:\n      - id: code\n        agent: scout", { plan: "Plan.", code: "Code." });
		const { from, point, resumed } = await killedAndResumed(flow, { plan: { todo: ["a", "b"] }, "work/code": "done" }, "work[2]/code", { "work/code": "done" });
		assert.deepEqual(point.ok && point.from, "work[2]/code");
		assert.deepEqual(added(resumed, from), ["visit_end work[2]/code", "visit_end work", "run_end"]);
	});

	test("after a parallel, keeps every branch that ended, the last one included", async () => {
		const branch = (name: string) => `      ${name}:\n        - id: w${name}\n          agent: scout\n`;
		const flow = checked(`  - id: both\n    parallel:\n${branch("a")}${branch("b")}  - id: after\n    agent: synthesiser`, { wa: "A.", wb: "B.", after: "After." });
		const { from, point, resumed } = await killedAndResumed(flow, { "both/a/wa": "a", "both/b/wb": "b", after: "done" }, "after", { after: "done" });
		assert.deepEqual(point.ok && point.from, "after");
		assert.deepEqual(added(resumed, from), ["visit_end after", "run_end"]);
	});

	test("inside a sub-flow, runs the callee's visits that did not end, and what follows the call", async () => {
		const g = flowText("  - id: first\n    agent: scout\n  - id: second\n    agent: planner", { first: "First.", second: "Second." }, "input: string", "g");
		const flow = checkedIn("f", { f: flowText("  - id: spec\n    flow: g\n    input: input\n  - id: after\n    agent: synthesiser", { after: "After." }), g });
		const { from, point, resumed } = await killedAndResumed(flow, { "spec/first": "one", "spec/second": "two", after: "done" }, "spec/second", { "spec/second": "two", after: "done" });
		assert.deepEqual(point.ok && point.from, "spec/second");
		assert.deepEqual(added(resumed, from), ["visit_end spec/second", "visit_end spec", "visit_end after", "run_end"]);
	});

	test("never asks an answered question again, and keeps a failure `on-fail: continue` read on", async () => {
		const flow = checked('  - id: pick\n    ask: "Ship it?"\n    options: [Yes, No]\n  - id: look\n    agent: scout\n    on-fail: continue\n  - id: after\n    agent: synthesiser', { look: "Look.", after: "After." });
		const { from, resumed } = await killedAndResumed(flow, { pick: { answered: true, answer: "Yes" }, look: { fail: "provider" }, after: "done" }, "after", { after: "done" });
		assert.deepEqual(added(resumed, from), ["visit_end after", "run_end"]);
	});
});

describe("a resume of a failed run", () => {
	const LOOPING = checked(
		"  - id: fix\n    loop: judge.output.done\n    max: 3\n    do:\n      - id: work\n        agent: scout\n      - id: judge\n        agent: reviewer\n        output: { done: boolean }",
		{ work: "Work.", judge: "Judge." },
	);

	test("replays its failure chain, what ended before it kept", async () => {
		const failed = await dryRunFlow(LOOPING, "x", { "fix/work": ["w1", { fail: "provider" }], "fix/judge": { done: false } });
		assert.deepEqual(!failed.ok && "error" in failed && [failed.error.kind, failed.path], ["provider", "fix#2/work"]);
		const from = journalOf(failed);
		const point = resumePoint(LOOPING, from);
		assert.deepEqual(point.ok && point.from, "fix#2/work");
		const resumed = await dryRunFlow(LOOPING, "x", { "fix#2/work": "w2", "fix#2/judge": { done: true } }, { from });
		assert.ok(resumed.ok, JSON.stringify(resumed));
		assert.deepEqual(added(resumed, from), ["visit_end fix#2/work", "visit_end fix#2/judge", "visit_end fix", "run_end"]);
	});

	test("asks again a question declined with the stop key", async () => {
		const flow = checked('  - id: pick\n    ask: "Ship it?"\n    options: [Yes, No]\n  - id: look\n    agent: scout', { look: "Look." });
		const stopped = await dryRunFlow(flow, "x", { pick: { fail: "stopped" } });
		const from = journalOf(stopped);
		const resumed = await dryRunFlow(flow, "x", { pick: { answered: true, answer: "No" }, look: "seen" }, { from });
		assert.ok(resumed.ok, JSON.stringify(resumed));
		assert.deepEqual(added(resumed, from), ["visit_end pick", "visit_end look", "run_end"]);
	});

	test("is refused when the flow decided the failure, when the run ended well, and for another flow's journal", async () => {
		const capped = await dryRunFlow(LOOPING, "x", { "fix/work": "w", "fix/judge": { done: false } });
		const refusal = async (flow: CheckedFlow, from: readonly JournalEntry[]) => {
			const run = await dryRunFlow(flow, "x", {}, { from });
			return !run.ok && "refused" in run ? run.refused : JSON.stringify(run);
		};
		assert.match(await refusal(LOOPING, journalOf(capped)), /^the run failed at `fix` by a decision of the flow \(unconverged: reached `max: 3`/);
		const other = checked("  - id: look\n    agent: scout", { look: "Look." });
		const ended = journalOf(await dryRunFlow(other, "x", { look: "seen" }));
		assert.equal(await refusal(other, ended), "the run already ended well: there is nothing to resume");
		assert.match(await refusal(LOOPING, ended), /names the visit `look`, which `f` does not have/);
	});
});
