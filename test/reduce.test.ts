import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failed, type Result } from "../src/result.ts";
import { emptyUsage } from "../src/usage.ts";
import { formatBranches, reduce } from "../src/workflows/reduce.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const synthesiser = testAgent("synthesiser");

const branch = (agent: string, output: string, over: Partial<Result> = {}): Result => ({
	agent,
	output,
	messages: [],
	usage: { ...emptyUsage(), turns: 1, input: 100, busyMs: 10 },
	ok: true,
	...over,
});

const branches = [branch("scout", "the parser lives in src/parse.ts"), branch("scout", "the lexer lives in src/lex.ts")];

describe("reduce", () => {
	test("hands every branch to one agent, and returns its answer", async () => {
		const fake = fakeSpawn(() => ({ output: "both live in src/" }));
		const result = await reduce({
			agent: synthesiser,
			results: branches,
			input: "Where does the parsing happen?",
			spawn: fake.spawn,
		});

		assert.equal(fake.spawned.length, 1, "a reduction is N→1: one agent, one turn");
		assert.equal(result.output, "both live in src/");
		assert.equal(result.agent, "synthesiser");
		assert.equal(result.ok, true);
	});

	test("the prompt carries the instruction and every branch", async () => {
		const fake = fakeSpawn();
		await reduce({ agent: synthesiser, results: branches, input: "Where does the parsing happen?", spawn: fake.spawn });

		const prompt = fake.asks[0]?.task ?? "";
		assert.match(prompt, /Where does the parsing happen\?/);
		assert.match(prompt, /src\/parse\.ts/);
		assert.match(prompt, /src\/lex\.ts/);
	});

	test("steps hold the branches then the synthesis, so the whole N→1 can be summed", async () => {
		const fake = fakeSpawn(() => ({ output: "summary", usage: { input: 7 } }));
		const result = await reduce({ agent: synthesiser, results: branches, input: "x", spawn: fake.spawn });

		assert.equal(result.steps.length, 3);
		assert.deepEqual(
			result.steps.map((step) => step.agent),
			["scout", "scout", "synthesiser"],
		);
		assert.equal(
			result.steps.reduce((total, step) => total + step.usage.input, 0),
			207,
			"the branches' tokens are part of the reduction's cost",
		);
	});

	test("a failed branch is shown to the reducer, never silently dropped", async () => {
		const fake = fakeSpawn();
		await reduce({
			agent: synthesiser,
			results: [branches[0] as Result, failed("scout", "provider exploded")],
			input: "Where does the parsing happen?",
			spawn: fake.spawn,
		});

		const prompt = fake.asks[0]?.task ?? "";
		assert.match(prompt, /failed/, "a synthesis that hides a crashed branch is a confident lie");
		assert.match(prompt, /provider exploded/);
	});

	test("a custom format replaces the default rendering entirely", async () => {
		const fake = fakeSpawn();
		await reduce({
			agent: synthesiser,
			results: branches,
			input: "merge",
			format: (results) => results.map((result) => result.output).join(" | "),
			spawn: fake.spawn,
		});

		assert.equal(fake.asks[0]?.task, "the parser lives in src/parse.ts | the lexer lives in src/lex.ts");
	});

	test("nothing to synthesise is a caller error, not an empty answer", async () => {
		await assert.rejects(() => reduce({ agent: synthesiser, results: [], input: "x" }), /nothing to synthesise/);
	});

	test("a failing reducer is a result, not a throw - and keeps the branches", async () => {
		const fake = fakeSpawn(() => ({ ok: false, error: "provider exploded" }));
		const result = await reduce({ agent: synthesiser, results: branches, input: "x", spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.steps.length, 3, "what was collected survives the reducer's failure");
	});

	test("cancellation: nothing is spawned, and the branches are still returned", async () => {
		const fake = fakeSpawn();
		const result = await reduce({
			agent: synthesiser,
			results: branches,
			input: "x",
			signal: AbortSignal.abort(),
			spawn: fake.spawn,
		});

		assert.equal(fake.spawned.length, 0);
		assert.equal(result.error, "aborted");
		assert.deepEqual(result.steps.slice(0, 2), branches);
	});

	test("the signal reaches the turn, and the subagent is closed whatever happens", async () => {
		const controller = new AbortController();
		const fake = fakeSpawn();
		await reduce({ agent: synthesiser, results: branches, input: "x", signal: controller.signal, spawn: fake.spawn });

		assert.equal(fake.askOptions[0]?.signal, controller.signal);
		assert.deepEqual(
			fake.closed,
			fake.spawned.map((entry) => entry.id),
		);
	});

	test("lifetime is passed down, but cannot change the shape: one spawn either way", async () => {
		const disposable = fakeSpawn();
		await reduce({ agent: synthesiser, results: branches, input: "x", spawn: disposable.spawn });

		const persistent = fakeSpawn();
		await reduce({ agent: synthesiser, results: branches, input: "x", lifetime: "workflow", spawn: persistent.spawn });

		assert.equal(disposable.spawned.length, 1);
		assert.equal(persistent.spawned.length, 1);
		assert.equal(disposable.spawned[0]?.options.lifetime, "task");
		assert.equal(persistent.spawned[0]?.options.lifetime, "workflow");
		// Whoever opens, closes - persistence does not exempt this combinator.
		assert.deepEqual(persistent.closed, ["synthesiser#1"]);
	});

	test("the run settings reach the subagent, exports included", async () => {
		const fake = fakeSpawn();
		await reduce({
			agent: synthesiser,
			results: branches,
			input: "x",
			cwd: "/somewhere",
			exportDir: "/tmp/run",
			spawn: fake.spawn,
		});

		assert.equal(fake.spawned[0]?.options.cwd, "/somewhere");
		assert.deepEqual(fake.exported, [{ id: "synthesiser#1", dir: "/tmp/run" }]);
	});
});

describe("formatBranches", () => {
	test("numbers the branches: several of them share an agent name", () => {
		const text = formatBranches(branches, "Where does the parsing happen?");
		assert.match(text, /## 1\. scout/);
		assert.match(text, /## 2\. scout/);
	});

	test("an empty output still gets a section, marked as such", () => {
		const text = formatBranches([branch("scout", "   ")], "x");
		assert.match(text, /\(no output\)/);
	});

	test("the instruction comes first: the reducer reads what to do before what to read", () => {
		const text = formatBranches(branches, "Merge these findings");
		assert.ok(text.startsWith("Merge these findings"));
	});
});
