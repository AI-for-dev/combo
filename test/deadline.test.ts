/**
 * How a deadline reads: one phrase, the bound written the way a flow file
 * writes it, and in milliseconds only when it is not whole seconds.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { expiry, timedOutAfter } from "../src/deadline.ts";

test("a bound of whole seconds reads as a flow file writes it", () => {
	assert.deepEqual([1_000, 90_000, 1_800_000, 5_400_000].map(timedOutAfter), ["timed out after 1s", "timed out after 1m30s", "timed out after 30m", "timed out after 1h30m"]);
});

test("a bound that is not whole seconds reads in milliseconds, never rounded", () => {
	assert.deepEqual([20, 1_500].map(timedOutAfter), ["timed out after 20ms", "timed out after 1500ms"]);
});

test("the reason a deadline aborts with says the same", () => {
	assert.equal(expiry(1_800_000).message, "timed out after 30m");
});
