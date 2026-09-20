import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failed, joinOutputs, type Result } from "../src/result.ts";
import { emptyUsage } from "../src/usage.ts";

const said = (agent: string, output: string): Result => ({ agent, output, messages: [], usage: emptyUsage(), ok: true });

describe("joinOutputs", () => {
	test("one section per result, named after its agent", () => {
		assert.equal(joinOutputs([said("scout", "found it"), said("coder", "wrote it")]), "## scout\n\nfound it\n\n## coder\n\nwrote it");
	});

	test("a failed result keeps its section, marked, with the error where the output would be", () => {
		assert.equal(joinOutputs([said("scout", "found it"), failed("coder", "402 from the provider")]), "## scout\n\nfound it\n\n## coder (failed)\n\n402 from the provider");
	});

	test("nothing in, nothing out", () => {
		assert.equal(joinOutputs([]), "");
	});
});
