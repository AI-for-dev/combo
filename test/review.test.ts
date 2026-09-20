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
import { reviewRecord } from "../src/review.ts";
import { emptyUsage } from "../src/usage.ts";
import { callTool } from "./fixtures/call-tool.ts";

const review = (output = "prose", ok = true): Result => ({ agent: "reviewer", output, messages: [], usage: emptyUsage(), ok });

const byTool = () => reviewRecord("reviewer", { byTool: true, inProse: () => false });

describe("a reviewer that decides by tool", () => {
	test("is handed a tool, and its call is what a round decides", async () => {
		const record = byTool();
		assert.ok(record.tool);
		assert.equal(record.byTool, true);

		await callTool(record.tool, { approved: true });
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
		await callTool(record.tool!, { approved: false, remarks: "not yet" });
		await callTool(record.tool!, { approved: true });

		assert.equal((await record.close(review(), 1)).approved, true);
	});

	test("what a round raises is owed until a later round closes it, under the id it was given", async () => {
		const record = byTool();
		await callTool(record.tool!, { approved: false, raised: ["the parser drops the last token"] });
		const first = await record.close(review(), 1);

		assert.deepEqual(first.raised, ["the parser drops the last token"]);
		assert.deepEqual(record.open.map((one) => [one.id, one.openedBy, one.openedAt]), [["o1", "reviewer", 1]]);

		await callTool(record.tool!, { approved: true, resolved: [{ id: "o1", how: "addressed" }] });
		const second = await record.close(review(), 2);

		assert.equal(second.approved, true);
		assert.deepEqual(record.open, []);
		assert.deepEqual(record.all.map((one) => one.closed?.at), [2]);
	});

	test("saying yes over an open obligation does not finish the work", async () => {
		const record = byTool();
		await callTool(record.tool!, { approved: false, raised: ["one", "two"] });
		await record.close(review(), 1);
		await callTool(record.tool!, { approved: true, resolved: [{ id: "o1", how: "addressed" }] });
		const round = await record.close(review(), 2);

		assert.equal(round.said, true, "the reviewer said yes");
		assert.equal(round.approved, false, "and o2 was still open");
		assert.deepEqual(record.open.map((one) => one.id), ["o2"]);
	});

	test("closures are applied before raises: a round cannot raise and close the same obligation", async () => {
		const record = byTool();
		await callTool(record.tool!, { approved: true, raised: ["one"], resolved: [{ id: "o1", how: "addressed" }] });
		const round = await record.close(review(), 1);

		assert.equal(round.approved, false);
		assert.equal(record.all[0]?.closed, undefined);
	});

	test("an id nothing is open for is refused by the tool, named back, and closes nothing", async () => {
		const record = byTool();
		const answer = await callTool(record.tool!, { approved: true, resolved: [{ id: "1", how: "addressed" }] });

		assert.match(answer.content[0]?.text ?? "", /Recorded: approved\. Nothing was closed for 1/);
		const round = await record.close(review(), 1);
		assert.equal(round.approved, true, "the decision is not lost to the bookkeeping beside it");
		assert.deepEqual(record.all, []);
	});

	test("a review that did not run to completion decided nothing, and what it collected is dropped", async () => {
		const record = byTool();
		await callTool(record.tool!, { approved: true });
		const failed = await record.close(review("", false), 1);
		assert.deepEqual(failed, { said: false, approved: false, raised: [] });

		const next = await record.close(review(), 2);
		assert.equal(next.verdict, undefined, "the earlier call is not read as this round's");
	});

	test("carries on from what a previous run recorded, without reusing an id", async () => {
		const record = reviewRecord("reviewer", {
			byTool: true,
			inProse: () => false,
			restored: [{ id: "o3", openedBy: "reviewer", text: "carried in", openedAt: 1 }],
		});
		assert.deepEqual(record.open.map((one) => one.id), ["o3"]);

		await callTool(record.tool!, { approved: true, raised: ["new"], resolved: [{ id: "o3", how: "addressed" }] });
		await record.close(review(), 2);

		assert.deepEqual(record.all.map((one) => [one.id, one.closed?.at]), [["o3", 2], ["o4", undefined]]);
	});
});

describe("a reviewer that decides in prose", () => {
	test("has no tool, and the round is what the reading of its prose says", async () => {
		const seen: number[] = [];
		const record = reviewRecord("reviewer", {
			byTool: false,
			inProse: (one, round) => {
				seen.push(round);
				return one.output.includes("LGTM");
			},
		});

		assert.equal(record.tool, undefined);
		assert.deepEqual(await record.close(review("not yet"), 1), { said: false, approved: false, raised: [] });
		assert.deepEqual(await record.close(review("LGTM"), 2), { said: true, approved: true, raised: [] });
		assert.deepEqual(seen, [1, 2]);
	});

	test("a failed review is not read at all", async () => {
		const record = reviewRecord("reviewer", { byTool: false, inProse: () => true });
		assert.equal((await record.close(review("LGTM", false), 1)).approved, false);
	});
});
