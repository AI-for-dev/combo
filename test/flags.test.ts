import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBuildArgs } from "../extension/flags.ts";

describe("parseBuildArgs", () => {
	test("a bare request stays a request", () => {
		assert.deepEqual(parseBuildArgs("build a cache"), { request: "build a cache" });
	});

	test("--pipeline takes the name, and leaves the rest alone", () => {
		assert.deepEqual(parseBuildArgs("--pipeline audit check the parser"), {
			pipeline: "audit",
			request: "check the parser",
		});
		assert.deepEqual(parseBuildArgs("--pipeline=audit x"), { pipeline: "audit", request: "x" });
	});

	test("a flag in the middle is part of the request: it is free text", () => {
		assert.deepEqual(parseBuildArgs("fix the --pipeline flag"), { request: "fix the --pipeline flag" });
	});

	test("--model takes a pattern, in either order with --pipeline", () => {
		assert.deepEqual(parseBuildArgs("--model local/qwen add a cache"), {
			model: "local/qwen",
			request: "add a cache",
		});
		assert.deepEqual(parseBuildArgs("--model local/qwen --pipeline audit x"), {
			model: "local/qwen",
			pipeline: "audit",
			request: "x",
		});
		assert.deepEqual(parseBuildArgs("--pipeline audit --model=local/qwen x"), {
			model: "local/qwen",
			pipeline: "audit",
			request: "x",
		});
	});

	test("a line continuation between two flags is read as a gap", () => {
		assert.deepEqual(parseBuildArgs("--pipeline audit \\\n  --model local/qwen add a cache"), {
			pipeline: "audit",
			model: "local/qwen",
			request: "add a cache",
		});
	});

	test("a backslash inside the request is the user's, and stays there", () => {
		assert.deepEqual(parseBuildArgs("--model local/qwen escape the \\\n in the parser"), {
			model: "local/qwen",
			request: "escape the \\\n in the parser",
		});
	});

	test("an unknown leading flag is free text, not a swallowed argument", () => {
		assert.deepEqual(parseBuildArgs("--force the issue"), { request: "--force the issue" });
	});
});

describe("parseBuildArgs, with a switch", () => {
	test("--worktree takes no value, so the request that follows it survives", () => {
		assert.deepEqual(parseBuildArgs("--worktree add a cache"), { worktree: true, request: "add a cache" });
	});

	test("it mixes with the valued flags, in any order", () => {
		assert.deepEqual(parseBuildArgs("--worktree --model local/one add a cache"), {
			worktree: true,
			model: "local/one",
			request: "add a cache",
		});
		assert.deepEqual(parseBuildArgs("--model local/one --worktree add a cache"), {
			model: "local/one",
			worktree: true,
			request: "add a cache",
		});
	});

	test("`--worktree=false` is a refusal, and saying nothing is not one", () => {
		// The three answers are distinct now: a delivery left to itself gives each
		// of several subtasks a copy, and this is how someone says not to.
		assert.equal(parseBuildArgs("--worktree=false add a cache").worktree, false);
		assert.equal(parseBuildArgs("--worktree=true add a cache").worktree, true);
		assert.equal(parseBuildArgs("add a cache").worktree, undefined);
	});

	test("without it the request is untouched, switch or not", () => {
		assert.deepEqual(parseBuildArgs("add a --worktree to the loader"), {
			request: "add a --worktree to the loader",
		});
	});
});

describe("parseBuildArgs, for the interview", () => {
	test("--questions takes a count, and a count that is not one is dropped", () => {
		assert.equal(parseBuildArgs("--questions 2 add a cache").questions, 2);
		assert.equal(parseBuildArgs("--questions x add a cache").questions, undefined, "a typo must not become 0");
		assert.equal(parseBuildArgs("--questions 0 add a cache").questions, undefined, "nor skip the interview");
		assert.equal(parseBuildArgs("add a cache").questions, undefined);
	});
});
