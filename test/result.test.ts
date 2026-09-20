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

	test("an empty output is said to be empty, not left as a heading over nothing", () => {
		assert.equal(joinOutputs([said("scout", "   ")]), "## scout\n\n(no output)");
	});

	test("numbered, so a reader can name a branch when several share an agent", () => {
		assert.equal(joinOutputs([said("scout", "a"), said("scout", "b")], { numbered: true }), "## 1. scout\n\na\n\n## 2. scout\n\nb");
	});

	test("the note beside the heading is the caller's to say", () => {
		const note = (one: Result) => (one.ok ? "reviewed" : "failed");
		assert.equal(joinOutputs([said("coder", "done"), failed("scribe", "boom")], { note }), "## coder (reviewed)\n\ndone\n\n## scribe (failed)\n\nboom");
	});
});
