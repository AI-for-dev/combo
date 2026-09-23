/**
 * The dry run: the runner itself, every agent turn answered by a script that
 * is checked before the start, and a hole in the script apart from every
 * outcome of the flow.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dryRunFlow, type DryRun } from "../src/flow/index.ts";
import { checked } from "./fixtures/flow.ts";

const FLOW = checked(
	`  - id: plan
    agent: planner
    reads: [input]
    output: { first: scout | reviewer }
    retry: 1
  - id: gate
    choice:
      - when: plan.output.first == "scout"
        do:
          - id: look
            agent: scout
    default: []
  - id: answer
    agent: synthesiser
    reads: [gate]`,
	{ plan: "Plan.", look: "Look.", answer: "Answer." },
);

/** A dry run's journal, as `path ok`. */
function journal(run: DryRun): string[] {
	assert.ok("journal" in run, JSON.stringify(run));
	return run.journal.map((entry) => `${entry.path} ${entry.ok}`);
}

describe("a dry run", () => {
	test("walks the flow the real runner walks, a typed answer going through `submit`", async () => {
		const run = await dryRunFlow(FLOW, "x", { plan: { first: "scout" }, "gate/look": "found", answer: "done" }, { model: "p/m" });
		assert.deepEqual(run.ok && "output" in run && run.output, "done");
		assert.deepEqual(journal(run), ["plan true", "gate/look true", "gate true", "answer true"]);
		const plan = "journal" in run ? run.journal[0] : undefined;
		assert.deepEqual([plan?.output, plan?.agent, plan?.model], [{ first: "scout" }, "planner", "p/m"]);
		assert.deepEqual("usage" in run && [run.usage.input, run.usage.output, run.usage.cost], [0, 0, 0]);
	});

	test("consumes a list attempt by attempt, a failure taking its real path through `retry:`", async () => {
		const started = performance.now();
		const run = await dryRunFlow(FLOW, "x", { plan: [{ fail: "timeout" }, { first: "reviewer" }], answer: "done" });
		assert.ok(performance.now() - started < 1000, "a scripted timeout waits for no clock");
		assert.ok(run.ok);
		assert.deepEqual(journal(run), ["plan true", "gate true", "answer true"]);
	});

	test("ends as the flow ends when the script fails a node past its retries", async () => {
		const run = await dryRunFlow(FLOW, "x", { plan: [{ fail: "schema" }, { fail: "provider" }] });
		assert.deepEqual(!run.ok && "error" in run && [run.error, run.path], [{ kind: "provider", message: "scripted provider failure" }, "plan"]);
	});

	test("serves every attempt with one answer that is not a list", async () => {
		const flow = checked("  - id: look\n    agent: scout\n    retry: 2", { look: "Look." });
		const events: string[] = [];
		const run = await dryRunFlow(flow, "x", { look: { fail: "provider" } }, {
			onEvent: (event) => {
				if (event.type === "status" && event.status === "working") events.push(event.id);
			},
		});
		assert.deepEqual(!run.ok && "error" in run && run.error.kind, "provider");
		assert.equal(events.length, 3, "three attempts, each answered");
	});

	test("stops at the first visit its script does not answer, whatever the flow would absorb", async () => {
		const absorbing = checked("  - id: look\n    agent: scout\n    on-fail: continue\n  - id: after\n    agent: synthesiser", { look: "Look.", after: "After." });
		const run = await dryRunFlow(absorbing, "x", { after: "never reached" });
		assert.deepEqual(!run.ok && "unscripted" in run && [run.unscripted, journal(run)], ["look", ["look false"]]);
		const exhausted = await dryRunFlow(FLOW, "x", { plan: [{ fail: "provider" }] });
		assert.deepEqual(!exhausted.ok && "unscripted" in exhausted && exhausted.unscripted, "plan");
	});

	test("refuses a script before the start, with every fault in it", async () => {
		const run = await dryRunFlow(FLOW, "x", { pla: "x", plan: [{ first: "coder" }, { fail: "stopped" }], gate: "x", look: "x", answer: 3 });
		assert.ok(!run.ok && "faults" in run);
		assert.deepEqual(
			run.faults.map(({ code, at }) => `${code} ${at}`),
			["answer-unknown-node pla", "answer-off-schema plan[0]", "answer-fail-kind plan[1]", "answer-unknown-node gate", "answer-unknown-node look", "answer-off-schema answer"],
		);
		assert.deepEqual([run.faults[0]?.message, run.faults[4]?.message], ["`pla` names no agent node: did you mean `plan`?", "`look` names no agent node: did you mean `gate/look`?"]);
	});
});
