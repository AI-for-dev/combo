import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { orchestrate } from "../src/workflows/orchestrate.ts";
import { parsePlan, planningPrompt } from "../src/workflows/plan.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const planner = testAgent("planner", { description: "Splits work into independent subtasks" });
const scout = testAgent("scout", { description: "Finds where code lives" });
const coder = testAgent("coder", { description: "Writes and edits code" });
const synthesiser = testAgent("synthesiser", { description: "Merges findings into one answer" });
const workers = [scout, coder];

const plan = JSON.stringify([
	{ agent: "scout", task: "find the parser" },
	{ agent: "scout", task: "find the lexer" },
]);

/** The planner answers `answer`; everyone else echoes. */
const plannerSays = (answer: string) =>
	fakeSpawn((task, agent) => (agent.name === "planner" ? { output: answer } : { output: `${agent.name}(${task})` }));

describe("orchestrate", () => {
	test("plans, then runs the split it asked for", async () => {
		const fake = plannerSays(plan);
		const result = await orchestrate({ planner, workers, input: "explain the parsing", spawn: fake.spawn });

		assert.equal(result.ok, true);
		assert.deepEqual(
			result.plan.map((step) => `${step.agent.name}: ${step.task}`),
			["scout: find the parser", "scout: find the lexer"],
		);
		assert.deepEqual(
			fake.spawned.map((entry) => entry.agent),
			["planner", "scout", "scout"],
		);
		assert.equal(result.results.length, 2);
	});

	test("the planner sees who it may delegate to, and what they are for", async () => {
		const fake = plannerSays(plan);
		await orchestrate({ planner, workers, input: "explain the parsing", spawn: fake.spawn });

		const prompt = fake.asks[0]?.task ?? "";
		assert.match(prompt, /- scout: Finds where code lives/);
		assert.match(prompt, /- coder: Writes and edits code/);
		assert.match(prompt, /explain the parsing/);
	});

	test("branches stay independent: one subagent per subtask, no shared context", async () => {
		const fake = plannerSays(plan);
		await orchestrate({ planner, workers, input: "x", lifetime: "workflow", spawn: fake.spawn });

		const scouts = fake.spawned.filter((entry) => entry.agent === "scout");
		assert.equal(scouts.length, 2, "two branches of the same agent are still two subagents");
	});

	test("usage covers the planning, not only the work it caused", async () => {
		const fake = fakeSpawn((_task, agent) =>
			agent.name === "planner" ? { output: plan, usage: { input: 500 } } : { usage: { input: 100 } },
		);
		const result = await orchestrate({ planner, workers, input: "x", spawn: fake.spawn });

		assert.equal(result.usage.input, 700, "deciding the split costs tokens too");
		assert.equal(result.usage.turns, 3);
	});

	test("reduceWith turns the branches into one answer", async () => {
		const fake = fakeSpawn((task, agent) => {
			if (agent.name === "planner") return { output: plan };
			if (agent.name === "synthesiser") return { output: "one answer" };
			return { output: `${agent.name}(${task})` };
		});
		const result = await orchestrate({ planner, workers, input: "x", reduceWith: synthesiser, spawn: fake.spawn });

		assert.equal(result.answer?.output, "one answer");
		assert.equal(result.usage.turns, 4, "planning, two branches, and the synthesis");
	});

	test("no reducer means no synthesis: the caller gets the branches", async () => {
		const fake = plannerSays(plan);
		const result = await orchestrate({ planner, workers, input: "x", spawn: fake.spawn });
		assert.equal(result.answer, undefined);
	});

	test("an unreadable plan runs nothing, and shows what the planner said", async () => {
		const fake = plannerSays("I would start by looking at the parser, then maybe the lexer.");
		const result = await orchestrate({ planner, workers, input: "x", spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /no runnable plan/);
		assert.match(result.error ?? "", /looking at the parser/);
		assert.equal(fake.spawned.length, 1, "only the planner ran");
	});

	test("a step naming an unknown agent is dropped, never remapped", async () => {
		const fake = plannerSays(JSON.stringify([{ agent: "ghost", task: "do magic" }, { agent: "scout", task: "find it" }]));
		const result = await orchestrate({ planner, workers, input: "x", spawn: fake.spawn });

		assert.equal(result.plan.length, 1);
		assert.equal(result.plan[0]?.agent.name, "scout");
	});

	test("a plan over maxTasks fails before anything is spawned", async () => {
		const big = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ agent: "scout", task: `task ${i}` })));
		const fake = plannerSays(big);
		const result = await orchestrate({ planner, workers, input: "x", maxTasks: 3, spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /exceeds maxTasks \(3\)/);
		assert.equal(fake.spawned.length, 1, "paying for a runaway plan is worse than losing the run");
	});

	test("the cap is announced to the planner, so it is not a surprise", async () => {
		const fake = plannerSays(plan);
		await orchestrate({ planner, workers, input: "x", maxTasks: 3, spawn: fake.spawn });
		assert.match(fake.asks[0]?.task ?? "", /at most 3 independent subtasks/);
	});

	test("a failing planner stops everything", async () => {
		const fake = fakeSpawn((_task, agent) => (agent.name === "planner" ? { ok: false, error: "provider exploded" } : {}));
		const result = await orchestrate({ planner, workers, input: "x", spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.equal(result.error, "provider exploded");
		assert.deepEqual(result.results, []);
	});

	test("a failing branch does not crash the orchestration, but it is not a success either", async () => {
		const fake = fakeSpawn((task, agent) => {
			if (agent.name === "planner") return { output: plan };
			return task.includes("lexer") ? { ok: false, error: "branch exploded" } : {};
		});
		const result = await orchestrate({ planner, workers, input: "x", spawn: fake.spawn });

		assert.equal(result.results.length, 2);
		assert.equal(result.ok, false);
		assert.equal(result.error, "branch exploded");
	});

	test("no worker at all is a caller error", async () => {
		await assert.rejects(() => orchestrate({ planner, workers: [], input: "x" }), /nobody to delegate to/);
	});

	test("cancellation: nothing is spawned", async () => {
		const fake = plannerSays(plan);
		const result = await orchestrate({ planner, workers, input: "x", signal: AbortSignal.abort(), spawn: fake.spawn });

		assert.equal(fake.spawned.length, 0);
		assert.equal(result.ok, false);
		assert.equal(result.error, "aborted");
	});

	test("everything opened is closed, planner included", async () => {
		const fake = plannerSays(plan);
		await orchestrate({ planner, workers, input: "x", spawn: fake.spawn });

		assert.deepEqual(
			fake.closed.sort(),
			fake.spawned.map((entry) => entry.id).sort(),
		);
	});

	test("lifetime: the branches are fresh in `task`, persistent in `workflow`", async () => {
		const repeated = JSON.stringify([
			{ agent: "scout", task: "one" },
			{ agent: "coder", task: "two" },
		]);

		const disposable = plannerSays(repeated);
		await orchestrate({ planner, workers, input: "x", spawn: disposable.spawn });

		const persistent = plannerSays(repeated);
		await orchestrate({ planner, workers, input: "x", lifetime: "workflow", spawn: persistent.spawn });

		assert.deepEqual(
			disposable.spawned.map((entry) => entry.options.lifetime),
			["task", "task", "task"],
		);
		assert.deepEqual(
			persistent.spawned.map((entry) => entry.options.lifetime),
			["workflow", "workflow", "workflow"],
		);
	});

	test("the run settings reach every level, exports included", async () => {
		const fake = plannerSays(plan);
		await orchestrate({ planner, workers, input: "x", cwd: "/somewhere", exportDir: "/tmp/run", spawn: fake.spawn });

		assert.ok(fake.spawned.every((entry) => entry.options.cwd === "/somewhere"));
		assert.equal(fake.exported.length, fake.spawned.length, "the planner's transcript is part of the run");
	});
});

describe("parsePlan", () => {
	test("reads plain JSON", () => {
		const parsed = parsePlan('[{"agent":"scout","task":"find it"}]', workers);
		assert.deepEqual(
			parsed.map((step) => [step.agent.name, step.task]),
			[["scout", "find it"]],
		);
	});

	test("reads JSON wrapped in prose or a code fence - which is what models do", () => {
		const fenced = 'Here is the plan:\n```json\n[{"agent":"coder","task":"write it"}]\n```\nHope that helps.';
		assert.equal(parsePlan(fenced, workers)[0]?.agent.name, "coder");
	});

	test("bare objects with no array around them - what a real planner sent back", () => {
		const bare = '{"agent": "scout", "task": "find the parser"}\n{"agent": "coder", "task": "write the fix"}';
		assert.deepEqual(
			parsePlan(bare, workers).map((step) => `${step.agent.name}|${step.task}`),
			["scout|find the parser", "coder|write the fix"],
		);
	});

	test("a single object is a plan of one, not a parse failure", () => {
		assert.equal(parsePlan('{"agent":"scout","task":"find it"}', workers).length, 1);
	});

	test("a brace inside a task does not end the object", () => {
		const tricky = '[{"agent":"coder","task":"replace {old} with {new}"}]';
		assert.equal(parsePlan(tricky, workers)[0]?.task, "replace {old} with {new}");
	});

	test("objects that are not steps are ignored, whatever else is in the answer", () => {
		const noisy = '{"thinking":"let me see"}\n{"agent":"scout","task":"find it"}';
		assert.equal(parsePlan(noisy, workers).length, 1);
	});

	test("falls back to one subtask per line", () => {
		const lines = "scout: find the parser\n- coder: write the fix\n2. scout: find the lexer";
		assert.deepEqual(
			parsePlan(lines, workers).map((step) => `${step.agent.name}|${step.task}`),
			["scout|find the parser", "coder|write the fix", "scout|find the lexer"],
		);
	});

	test("a task containing a colon survives the line form", () => {
		assert.equal(parsePlan("scout: find src/x.ts: the parser", workers)[0]?.task, "find src/x.ts: the parser");
	});

	test("unknown agents and empty tasks are dropped", () => {
		assert.deepEqual(parsePlan('[{"agent":"ghost","task":"x"},{"agent":"scout","task":"  "}]', workers), []);
	});

	test("agent names match whatever case the model used", () => {
		assert.equal(parsePlan('[{"agent":"Scout","task":"find it"}]', workers)[0]?.agent.name, "scout");
	});

	test("prose alone yields nothing, rather than a plan nobody asked for", () => {
		assert.deepEqual(parsePlan("I think we should look at the parser first.", workers), []);
	});

	test("malformed JSON does not throw", () => {
		assert.doesNotThrow(() => parsePlan('[{"agent": "scout", "task":', workers));
	});
});

describe("planningPrompt", () => {
	test("insists on independence: a dynamic fan-out cannot chain", () => {
		assert.match(planningPrompt("x", workers, 8), /run in parallel/);
	});

	test("shows the answer shape it wants", () => {
		assert.match(planningPrompt("x", workers, 8), /\[\{"agent": "name", "task": "what to do"\}\]/);
	});
});
