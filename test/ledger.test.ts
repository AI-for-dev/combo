/**
 * The ledger, on its own.
 *
 * This is where the three rules live, so this is where they are pinned: only
 * the opener closes, nothing is rewritten, and what nobody mentions stays open.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLedger, openList } from "../src/review/ledger.ts";

describe("createLedger", () => {
	test("an obligation keeps the id it was given, round after round", () => {
		const ledger = createLedger();
		const first = ledger.raise("reviewer", "the parser drops the last token", 1);
		ledger.raise("reviewer", "no test covers the empty input", 2);

		assert.equal(first.id, "o1");
		assert.deepEqual(
			ledger.all.map((one) => one.id),
			["o1", "o2"],
		);
		assert.equal(ledger.all[0]?.openedAt, 1);
		assert.equal(ledger.all[1]?.openedAt, 2);
	});

	test("nothing raised means nothing owed", () => {
		assert.equal(createLedger().settled, true);
	});

	test("only the agent that raised one may close it", () => {
		const ledger = createLedger();
		ledger.raise("reviewer", "fix the parser", 1);

		const byWorker = ledger.close("o1", "coder", { how: "addressed", at: 2 });
		assert.equal(byWorker.ok, false);
		assert.match(byWorker.ok ? "" : byWorker.error, /only reviewer may close it/);
		assert.equal(ledger.settled, false, "a refused closure leaves it open");

		assert.equal(ledger.close("o1", "reviewer", { how: "addressed", at: 2 }).ok, true);
		assert.equal(ledger.settled, true);
	});

	test("an obligation nobody mentions stays open", () => {
		const ledger = createLedger();
		ledger.raise("reviewer", "one", 1);
		ledger.raise("reviewer", "two", 1);
		ledger.close("o1", "reviewer", { how: "addressed", at: 2 });

		assert.deepEqual(
			ledger.open.map((one) => one.id),
			["o2"],
		);
		assert.equal(ledger.settled, false);
	});

	test("an id nobody raised, and one already closed, are both refused", () => {
		const ledger = createLedger();
		ledger.raise("reviewer", "one", 1);
		ledger.close("o1", "reviewer", { how: "addressed", at: 2 });

		assert.match(unwrap(ledger.close("o9", "reviewer", { how: "addressed", at: 3 })), /no obligation "o9"/);
		assert.match(unwrap(ledger.close("o1", "reviewer", { how: "addressed", at: 3 })), /already closed/);
	});

	test("a closure keeps its reason, and an empty one is no reason", () => {
		const ledger = createLedger();
		ledger.raise("reviewer", "one", 1);
		ledger.raise("reviewer", "two", 1);

		ledger.close("o1", "reviewer", { how: "withdrawn", reason: "  the code already did it  ", at: 2 });
		ledger.close("o2", "reviewer", { how: "addressed", reason: "   ", at: 2 });

		assert.deepEqual(ledger.all[0]?.closed, { how: "withdrawn", reason: "the code already did it", at: 2 });
		assert.deepEqual(ledger.all[1]?.closed, { how: "addressed", reason: undefined, at: 2 });
	});

	test("the text is kept as it was written, and closing does not touch it", () => {
		const ledger = createLedger();
		ledger.raise("reviewer", "  the parser drops the last token  ", 1);
		ledger.close("o1", "reviewer", { how: "addressed", at: 2 });

		assert.equal(ledger.all[0]?.text, "the parser drops the last token");
	});
});

describe("openList", () => {
	test("one id per line, so an agent can answer for each", () => {
		const ledger = createLedger();
		ledger.raise("reviewer", "one", 1);
		ledger.raise("reviewer", "two", 1);

		assert.equal(openList(ledger.open), "o1: one\no2: two");
		assert.equal(openList([]), "");
	});
});

/** The error of a refused closure, or a message saying it was not refused. */
function unwrap(outcome: ReturnType<ReturnType<typeof createLedger>["close"]>): string {
	return outcome.ok ? "(the closure was accepted)" : outcome.error;
}
