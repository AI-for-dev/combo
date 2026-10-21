import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readable } from "../extension/commands/readable.ts";

describe("readable", () => {
	test("leaves text as it is, and writes a scalar as itself", () => {
		assert.equal(readable("It is in `store.ts`.\n\n- one\n- two"), "It is in `store.ts`.\n\n- one\n- two");
		assert.equal(readable(3), "3");
		assert.equal(readable(false), "false");
		assert.equal(readable(null), "null");
		assert.equal(readable(undefined), "");
	});

	test("writes an object as one item per field, a one-line value beside its key", () => {
		assert.equal(readable({ committed: true, sha: "abc1234", branch: "combo/x" }), "- **committed**: true\n- **sha**: abc1234\n- **branch**: combo/x");
	});

	test("puts a text of several lines under its key, its lines and its Markdown kept", () => {
		assert.equal(
			readable({ task: "Split the loop.\n\nWork:\n1. Add `step()`.\n2. Call it.", agent: "coder" }),
			["- **task**:", "", "  Split the loop.", "", "  Work:", "  1. Add `step()`.", "  2. Call it.", "- **agent**: coder"].join("\n"),
		);
	});

	test("bullets a list of scalars, and numbers a list of objects, each field a paragraph of its item", () => {
		assert.equal(readable(["a", "b"]), "- a\n- b");
		// pi draws no number for an item that opens on a list, so the fields are paragraphs.
		assert.equal(
			readable([{ task: "Split the loop.\n\n1. Add `step()`.", agent: "coder" }, { task: "two", agent: "tester" }]),
			["1. **task**:", "", "   Split the loop.", "", "   1. Add `step()`.", "", "   **agent**: coder", "", "2. **task**: two", "", "   **agent**: tester"].join("\n"),
		);
		assert.equal(readable({ steps: ["read", "write"], done: false }), "- **steps**:\n  - read\n  - write\n- **done**: false");
	});

	test("says an empty list or object is empty, rather than writing nothing", () => {
		assert.equal(readable([]), "_empty_");
		assert.equal(readable({ remarks: [] }), "- **remarks**: _empty_");
	});
});
