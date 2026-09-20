import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { declares, refuse, said } from "../src/tool.ts";

describe("what a combo tool has in common", () => {
	test("an agent declares a tool by naming it in its own file, and nothing else counts", () => {
		assert.equal(declares(["read", "verdict"], "verdict"), true);
		assert.equal(declares(["read"], "verdict"), false);
		assert.equal(declares(undefined, "verdict"), false);
	});

	test("an answer and a refusal differ by one flag the model reads", () => {
		assert.deepEqual(said("done"), { content: [{ type: "text", text: "done" }], details: undefined });
		assert.deepEqual(refuse("no"), { content: [{ type: "text", text: "no" }], details: undefined, isError: true });
	});
});
