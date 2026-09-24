import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseFlags, parseInterviewArgs, parseLeadingFlags } from "../extension/flags.ts";

/** A line read with `/run`'s flags, `/step`'s switch and a count. */
const read = (args: string) => parseLeadingFlags(args, ["model", "timeout"], { switches: ["agent"], counts: ["rounds"] });

describe("parseLeadingFlags", () => {
	test("a bare line stays the rest", () => {
		assert.deepEqual(read("explore how usage is measured"), { flags: {}, rest: "explore how usage is measured" });
	});

	test("a flag takes one word, with a space or an `=`, in any order", () => {
		assert.deepEqual(read("--model local/qwen --timeout 10m explore x"), { flags: { model: "local/qwen", timeout: "10m" }, rest: "explore x" });
		assert.deepEqual(read("--timeout=10m --model=local/qwen explore x"), { flags: { model: "local/qwen", timeout: "10m" }, rest: "explore x" });
	});

	test("a flag after the first word is part of the rest: it is free text", () => {
		assert.deepEqual(read("explore fix the --model flag"), { flags: {}, rest: "explore fix the --model flag" });
	});

	test("an unknown leading flag is free text, not a swallowed argument", () => {
		assert.deepEqual(read("--force the issue"), { flags: {}, rest: "--force the issue" });
	});

	test("a line continuation between two flags is read as a gap", () => {
		assert.deepEqual(read("--model local/qwen \\\n  --timeout 10m explore x"), { flags: { model: "local/qwen", timeout: "10m" }, rest: "explore x" });
	});

	test("a backslash inside the rest is the user's, and stays there", () => {
		assert.deepEqual(read("--model local/qwen escape the \\\n in the parser").rest, "escape the \\\n in the parser");
	});

	test("a switch takes no value, so what follows it survives", () => {
		assert.deepEqual(read("--agent explore the parser"), { flags: { agent: "true" }, rest: "explore the parser" });
		assert.deepEqual(read("--agent=false --model local/one x"), { flags: { agent: "false", model: "local/one" }, rest: "x" });
		assert.deepEqual(read("--agent=TRUE x"), { flags: { agent: "true" }, rest: "x" });
	});

	test("a switch written with any other value is refused, not read as on", () => {
		for (const value of ["no", "off", "0", "yes", ""]) {
			assert.equal(read(`--agent=${value} explore x`).refused, `--agent takes no value, or =true or =false, not "${value}"`);
		}
	});

	test("a count is a whole number of at least 1, and anything else is refused", () => {
		assert.deepEqual(read("--rounds 2 x"), { flags: { rounds: "2" }, rest: "x" });
		for (const value of ["x", "0", "1.5", "-1"]) {
			assert.equal(read(`--rounds=${value} x`).refused, `--rounds takes a whole number of at least 1, not "${value}"`);
		}
	});

	test("a double-quoted value holds spaces, and a quote in the rest stays the user's", () => {
		assert.deepEqual(read('--model "local one" x'), { flags: { model: "local one" }, rest: "x" });
		assert.deepEqual(read('--model local/one fix the "npm test" script').rest, 'fix the "npm test" script');
	});
});

describe("parseFlags", () => {
	const flags = (args: string) => parseFlags(args, ["model", "timeout"]);

	test("a known flag ending the line is a flag, and so are two", () => {
		assert.deepEqual(flags("explore where is it --model local/one"), { flags: { model: "local/one" }, rest: "explore where is it" });
		assert.deepEqual(flags('explore "where is it" --model=local/one --timeout 10m'), { flags: { model: "local/one", timeout: "10m" }, rest: 'explore "where is it"' });
	});

	test("in the middle of the line, or unknown, it is the text; leading, it wins over a trailing one", () => {
		assert.deepEqual(flags("explore the --model flag and more"), { flags: {}, rest: "explore the --model flag and more" });
		assert.deepEqual(flags("explore x --force it"), { flags: {}, rest: "explore x --force it" });
		assert.deepEqual(flags("--model a explore x --model b"), { flags: { model: "a" }, rest: "explore x --model b" });
	});
});

describe("parseInterviewArgs", () => {
	test("--questions takes a count, and a count that is not one is refused", () => {
		assert.equal(parseInterviewArgs("--questions 2 add a cache").questions, 2);
		assert.equal(parseInterviewArgs("--questions x add a cache").refused, '--questions takes a whole number of at least 1, not "x"');
		assert.equal(parseInterviewArgs("--questions 0 add a cache").refused, '--questions takes a whole number of at least 1, not "0"');
		assert.equal(parseInterviewArgs("add a cache").questions, undefined);
	});

	test("--model reaches the interviewer", () => {
		assert.deepEqual(parseInterviewArgs("--model local/one --questions 3 add a cache"), {
			model: "local/one",
			questions: 3,
			request: "add a cache",
		});
	});
});
