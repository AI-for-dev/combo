/**
 * One line per board event, the way every pane and the console word it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { trafficLine } from "../src/reporters/traffic.ts";

describe("trafficLine", () => {
	test("a post that answers another says which, and whose", () => {
		const line = trafficLine({
			type: "post",
			id: "debater#2",
			post: { id: "p3", from: "debater#2", kind: "tell", text: "not for a new team", at: 1, re: { id: "p1", from: "debater#1" } },
		});

		assert.equal(line, "✉ debater#2 re p1 (debater#1) [tell] not for a new team");
	});
});
