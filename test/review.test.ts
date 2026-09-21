/**
 * The review record: the join between a reviewer's verdict and its ledger.
 *
 * What is asserted here is the join itself - the order of closures and raises,
 * what "approved" means, what a failed or silent turn amounts to - through the
 * one question a workflow asks it. The tool's own refusals are `verdict.test.ts`,
 * the ledger's own rules `ledger.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Result } from "../src/result.ts";
import { reviewRecord, type ReviewRecord } from "../src/review/review.ts";
import type { ToolDefinition } from "../src/session.ts";
import { emptyUsage } from "../src/usage.ts";
import { VERDICT_TOOL } from "../src/review/verdict.ts";
import { callTool } from "./fixtures/call-tool.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

const review = (output = "prose", ok = true): Result => ({ agent: "reviewer", output, messages: [], usage: emptyUsage(), ok });

const judge = testAgent("reviewer", { tools: ["read", VERDICT_TOOL] });
const reader = testAgent("reviewer", { tools: ["read"] });
const worker = testAgent("worker");

const byTool = () => reviewRecord(judge, { word: "LGTM" });
/** The tool a record offers its reviewer, and nobody else. */
const toolOf = (record: ReviewRecord): ToolDefinition => (record.offer()?.(judge) as ToolDefinition[])[0] as ToolDefinition;

describe("a reviewer that decides by tool", () => {
	test("is handed a tool, and its call is what a round decides", async () => {
		const record = byTool();
		assert.equal(record.byTool, true, "read off the agent's own tools");

		await callTool(toolOf(record), { approved: true });
		const round = await record.close(review(), 1);

		assert.deepEqual(round, { verdict: { approved: true, remarks: undefined, resolved: [], raised: [] }, said: true, approved: true, raised: [] });
	});

	test("calling nothing is not a refusal and not an approval: it never decided", async () => {
		const round = await byTool().close(review("Looks fine. LGTM"), 1);
		assert.equal(round.verdict, undefined, "absent, not `approved: false`");
		assert.equal(round.approved, false, "prose is not read once the tool is the channel");
	});

	test("the last call wins: an agent that calls again has changed its mind", async () => {
		const record = byTool();
		await callTool(toolOf(record), { approved: false, remarks: "not yet" });
		await callTool(toolOf(record), { approved: true });

		assert.equal((await record.close(review(), 1)).approved, true);
	});

	test("what a round raises is owed until a later round closes it, under the id it was given", async () => {
		const record = byTool();
		await callTool(toolOf(record), { approved: false, raised: ["the parser drops the last token"] });
		const first = await record.close(review(), 1);

		assert.deepEqual(first.raised, ["the parser drops the last token"]);
		assert.deepEqual(record.open.map((one) => [one.id, one.openedBy, one.openedAt]), [["o1", "reviewer", 1]]);

		await callTool(toolOf(record), { approved: true, resolved: [{ id: "o1", how: "addressed" }] });
		const second = await record.close(review(), 2);

		assert.equal(second.approved, true);
		assert.deepEqual(record.open, []);
		assert.deepEqual(record.all.map((one) => one.closed?.at), [2]);
	});

	test("saying yes over an open obligation does not finish the work", async () => {
		const record = byTool();
		await callTool(toolOf(record), { approved: false, raised: ["one", "two"] });
		await record.close(review(), 1);
		await callTool(toolOf(record), { approved: true, resolved: [{ id: "o1", how: "addressed" }] });
		const round = await record.close(review(), 2);

		assert.equal(round.said, true, "the reviewer said yes");
		assert.equal(round.approved, false, "and o2 was still open");
		assert.deepEqual(record.open.map((one) => one.id), ["o2"]);
	});

	test("closures are applied before raises: a round cannot raise and close the same obligation", async () => {
		const record = byTool();
		await callTool(toolOf(record), { approved: true, raised: ["one"], resolved: [{ id: "o1", how: "addressed" }] });
		const round = await record.close(review(), 1);

		assert.equal(round.approved, false);
		assert.equal(record.all[0]?.closed, undefined);
	});

	test("an id nothing is open for is refused by the tool, named back, and closes nothing", async () => {
		const record = byTool();
		const answer = await callTool(toolOf(record), { approved: true, resolved: [{ id: "1", how: "addressed" }] });

		assert.match(answer.content[0]?.text ?? "", /Recorded: approved\. Nothing was closed for 1/);
		const round = await record.close(review(), 1);
		assert.equal(round.approved, true, "the decision is not lost to the bookkeeping beside it");
		assert.deepEqual(record.all, []);
	});

	test("a review that did not run to completion decided nothing, and what it collected is dropped", async () => {
		const record = byTool();
		await callTool(toolOf(record), { approved: true });
		const failed = await record.close(review("", false), 1);
		assert.deepEqual(failed, { said: false, approved: false, raised: [] });

		const next = await record.close(review(), 2);
		assert.equal(next.verdict, undefined, "the earlier call is not read as this round's");
	});

	test("carries on from what a previous run recorded, without reusing an id", async () => {
		const record = reviewRecord(judge, {
			word: "LGTM",
			restored: [{ id: "o3", openedBy: "reviewer", text: "carried in", openedAt: 1 }],
		});
		assert.deepEqual(record.open.map((one) => one.id), ["o3"]);

		await callTool(toolOf(record), { approved: true, raised: ["new"], resolved: [{ id: "o3", how: "addressed" }] });
		await record.close(review(), 2);

		assert.deepEqual(record.all.map((one) => [one.id, one.closed?.at]), [["o3", 2], ["o4", undefined]]);
	});
});

describe("a reviewer that decides in prose", () => {
	test("has no tool, and the round is what the word alone on a line says", async () => {
		const record = reviewRecord(reader, { word: "LGTM" });

		assert.equal(record.byTool, false);
		assert.equal(record.offer(), undefined);
		assert.deepEqual(await record.close(review("not yet, LGTM is far"), 1), { said: false, approved: false, raised: [] });
		assert.deepEqual(await record.close(review("Fine.\n\nLGTM"), 2), { said: true, approved: true, raised: [] });
	});

	test("a caller's own reading stands in for the word, and for the tool the agent declares", async () => {
		const seen: number[] = [];
		const record = reviewRecord(judge, {
			word: "LGTM",
			approved: (one, round) => {
				seen.push(round);
				return one.output.includes("ship it");
			},
		});

		assert.equal(record.byTool, false, "the caller's rule is the nearer one");
		assert.deepEqual(await record.close(review("not yet"), 1), { said: false, approved: false, raised: [] });
		assert.deepEqual(await record.close(review("ship it"), 2), { said: true, approved: true, raised: [] });
		assert.deepEqual(seen, [1, 2]);
	});

	test("a failed review is not read at all", async () => {
		const record = reviewRecord(reader, { word: "LGTM", approved: () => true });
		assert.equal((await record.close(review("LGTM", false), 1)).approved, false);
	});
});

describe("the terms a round is asked on", () => {
	test("in prose: the word alone, and nothing owed since nothing can be raised", () => {
		assert.equal(reviewRecord(reader, { word: "APPROVED" }).terms(), "Answer APPROVED alone when you have nothing left to ask for.");
	});

	test("by tool with nothing owed: the call is the decision", () => {
		assert.equal(byTool().terms(), "End by calling the `verdict` tool: that call is what is read as your decision.");
	});

	test("by tool with lines owed: they are listed by id, and one left unnamed stays open", async () => {
		const record = byTool();
		await callTool(toolOf(record), { approved: false, raised: ["one", "two"] });
		await record.close(review(), 1);

		assert.equal(
			record.terms(),
			[
				"Still open, from your earlier rounds:",
				"o1: one",
				"o2: two",
				"",
				"End by calling the `verdict` tool: that call is what is read as your decision.",
				"Name in `resolved` every id above you are done with. One you leave out stays open, and the work is not finished while anything is.",
			].join("\n"),
		);
	});
});

describe("what a record offers", () => {
	test("the tool to its reviewer and nobody else; everybody else gets what the caller offered", () => {
		const others = (agent: { name: string }) => (agent.name === "worker" ? [{ name: "hammer" } as ToolDefinition] : undefined);
		const offer = byTool().offer(others);

		assert.equal((offer?.(judge) as ToolDefinition[])[0]?.name, VERDICT_TOOL);
		assert.deepEqual(offer?.(worker), [{ name: "hammer" }]);
	});

	test("a reviewer deciding in prose leaves the caller's offer as it was", () => {
		const others = () => undefined;
		assert.equal(reviewRecord(reader, { word: "LGTM" }).offer(others), others);
	});
});
