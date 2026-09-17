/**
 * The verdict tool, on its own.
 *
 * The tool body is our code, so it is testable without a model: what matters is
 * what reaches the collector and what does not.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { declaresVerdict, lastVerdict, verdictTool, type Verdict } from "../src/verdict.ts";
import { callTool as call } from "./fixtures/call-tool.ts";

describe("verdictTool", () => {
	test("an approval reaches the collector", async () => {
		const verdicts = verdictTool();
		await call(verdicts.tool, { approved: true });

		assert.deepEqual(verdicts.take(), [{ approved: true, remarks: undefined, resolved: [], raised: [] }]);
	});

	test("an approval that sends an empty string has no remarks", async () => {
		const verdicts = verdictTool();
		await call(verdicts.tool, { approved: true, remarks: "" });

		assert.deepEqual(verdicts.take(), [{ approved: true, remarks: undefined, resolved: [], raised: [] }]);
	});

	test("a refusal keeps its remarks", async () => {
		const verdicts = verdictTool();
		await call(verdicts.tool, { approved: false, remarks: "  the parser drops the last token  " });

		assert.deepEqual(verdicts.take(), [{ approved: false, remarks: "the parser drops the last token", resolved: [], raised: [] }]);
	});

	test("a refusal with nothing to act on is refused, and records nothing", async () => {
		const verdicts = verdictTool();
		const answer = await call(verdicts.tool, { approved: false, remarks: "   " });

		assert.equal(answer.isError, true, "the agent is told, so it can call again");
		assert.deepEqual(verdicts.take(), []);
	});

	test("a refusal that raises something needs no remarks: the obligations are the ask", async () => {
		const verdicts = verdictTool();
		const answer = await call(verdicts.tool, { approved: false, raised: ["  the parser drops the last token  ", "  "] });

		assert.notEqual(answer.isError, true);
		assert.deepEqual(verdicts.take(), [
			{ approved: false, remarks: undefined, resolved: [], raised: ["the parser drops the last token"] },
		]);
	});

	test("a resolution the schema allows but the ledger cannot read is dropped", async () => {
		const verdicts = verdictTool();
		await call(verdicts.tool, {
			approved: true,
			resolved: [
				{ id: " o1 ", how: "addressed" },
				{ id: "o2", how: "maybe-later" },
				{ id: "o3", how: "withdrawn", reason: " it was wrong " },
			],
		});

		assert.deepEqual(verdicts.take()[0]?.resolved, [
			{ id: "o1", how: "addressed", reason: undefined },
			{ id: "o3", how: "withdrawn", reason: "it was wrong" },
		]);
	});

	test("taking drains, so a round reads its own decisions and not the previous ones", async () => {
		const verdicts = verdictTool();
		await call(verdicts.tool, { approved: false, remarks: "round one" });
		assert.equal(verdicts.take().length, 1);
		assert.deepEqual(verdicts.take(), [], "nothing is left behind for the next round");

		await call(verdicts.tool, { approved: true });
		assert.deepEqual(verdicts.take(), [{ approved: true, remarks: undefined, resolved: [], raised: [] }]);
	});
});

describe("lastVerdict", () => {
	test("an agent that never called has not decided", () => {
		assert.equal(lastVerdict([]), undefined);
	});

	test("an agent that called twice has changed its mind", () => {
		const given: Verdict[] = [
			{ approved: false, remarks: "no", resolved: [], raised: [] },
			{ approved: true, resolved: [], raised: [] },
		];
		assert.deepEqual(lastVerdict(given), { approved: true, resolved: [], raised: [] });
	});
});

describe("declaresVerdict", () => {
	test("only a definition that names the tool asks for it", () => {
		assert.equal(declaresVerdict(["read", "verdict"]), true);
		assert.equal(declaresVerdict(["read"]), false);
		assert.equal(declaresVerdict(undefined), false, "the read-only default names nothing");
	});
});
