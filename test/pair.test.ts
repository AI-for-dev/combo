import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { APPROVAL, pair } from "../src/workflows/pair.ts";
import { VERDICT_TOOL } from "../src/verdict.ts";
import { callTool } from "./fixtures/call-tool.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const worker = testAgent("coder", { description: "Writes code" });
const reviewer = testAgent("reviewer", { description: "Reviews code" });

/** The reviewer approves at round `n`; the worker echoes what it was given. */
const approvesAt = (n: number) => {
	let round = 0;
	return fakeSpawn((task, agent) => {
		if (agent.name !== "reviewer") return { output: `work after ${task.slice(0, 12)}` };
		round++;
		return { output: round >= n ? APPROVAL : `remark ${round}: fix the parser` };
	});
};

describe("pair", () => {
	test("returns the worker's work, not the reviewer's verdict", async () => {
		const fake = approvesAt(1);
		const result = await pair({ worker, reviewer, input: "implement the parser", spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.equal(result.agent, "coder");
		assert.match(result.output, /^work after/, "handing `LGTM` to the next step would be useless");
		assert.equal(result.review?.output, APPROVAL);
	});

	test("the remarks go back to the worker, round after round", async () => {
		const fake = approvesAt(3);
		const result = await pair({ worker, reviewer, input: "implement the parser", spawn: fake.spawn });

		assert.equal(result.rounds, 3);
		assert.equal(result.approved, true);

		const toWorker = fake.asks.filter((ask) => ask.id.startsWith("coder"));
		assert.equal(toWorker.length, 3);
		assert.match(toWorker[1]?.task ?? "", /remark 1: fix the parser/, "round two starts from the remarks");
		assert.match(toWorker[2]?.task ?? "", /remark 2/);
	});

	test("the reviewer is told the goal, not only the summary", async () => {
		const fake = approvesAt(1);
		await pair({ worker, reviewer, input: "implement the parser", spawn: fake.spawn });

		const toReviewer = fake.asks.find((ask) => ask.id.startsWith("reviewer"));
		assert.match(toReviewer?.task ?? "", /implement the parser/);
		assert.match(toReviewer?.task ?? "", /Read the code itself/, "a review of a summary is not a review");
	});

	test("running out of rounds is not an approval", async () => {
		const fake = approvesAt(99);
		const result = await pair({ worker, reviewer, input: "x", maxRounds: 2, spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.equal(result.ok, true, "every turn ran fine; the bar was simply never reached");
		assert.equal(result.rounds, 2);
		assert.equal(result.steps.length, 4);
	});

	test("the last round says it is the last one", async () => {
		const fake = approvesAt(99);
		await pair({ worker, reviewer, input: "x", maxRounds: 2, spawn: fake.spawn });

		const toWorker = fake.asks.filter((ask) => ask.id.startsWith("coder"));
		assert.match(toWorker[1]?.task ?? "", /last round/);
	});

	test("a custom approval replaces the LGTM convention", async () => {
		const fake = fakeSpawn((_task, agent) => ({ output: agent.name === "reviewer" ? "ship it" : "work" }));
		const result = await pair({
			worker,
			reviewer,
			input: "x",
			approved: (review) => review.output.includes("ship it"),
			spawn: fake.spawn,
		});

		assert.equal(result.approved, true);
		assert.equal(result.rounds, 1);
	});

	test("a failing worker stops the pair: there is nothing to review", async () => {
		const fake = fakeSpawn((_task, agent) => (agent.name === "coder" ? { ok: false, error: "provider exploded" } : {}));
		const result = await pair({ worker, reviewer, input: "x", spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.approved, false);
		assert.equal(fake.asks.length, 1, "the reviewer was never called");
	});

	test("a failing reviewer stops the pair: there is nothing to fix", async () => {
		const fake = fakeSpawn((_task, agent) => (agent.name === "reviewer" ? { ok: false, error: "review exploded" } : {}));
		const result = await pair({ worker, reviewer, input: "x", spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.equal(result.steps.at(-1)?.error, "review exploded");
		assert.equal(result.ok, true, "the work itself is what is returned, and it succeeded");
	});

	test("usage covers both agents, every round", async () => {
		const fake = fakeSpawn((_task, agent) => ({
			output: agent.name === "reviewer" ? APPROVAL : "work",
			usage: { input: 100 },
		}));
		const result = await pair({ worker, reviewer, input: "x", spawn: fake.spawn });

		assert.equal(result.usage.input, 200);
		assert.equal(result.usage.turns, 2);
	});

	test("cancellation: nothing is spawned", async () => {
		const fake = approvesAt(1);
		const result = await pair({ worker, reviewer, input: "x", signal: AbortSignal.abort(), spawn: fake.spawn });

		assert.equal(fake.spawned.length, 0);
		assert.equal(result.error, "aborted");
		assert.equal(result.approved, false);
	});

	test("everything opened is closed", async () => {
		const fake = approvesAt(2);
		await pair({ worker, reviewer, input: "x", spawn: fake.spawn });

		assert.deepEqual(
			fake.closed.sort(),
			fake.spawned.map((entry) => entry.id).sort(),
		);
	});

	test("lifetime: a team by default, strangers on request", async () => {
		const team = approvesAt(3);
		await pair({ worker, reviewer, input: "x", spawn: team.spawn });

		const strangers = approvesAt(3);
		await pair({ worker, reviewer, input: "x", lifetime: "task", spawn: strangers.spawn });

		assert.equal(team.spawned.length, 2, "one worker and one reviewer, for the whole conversation");
		assert.equal(strangers.spawned.length, 6, "a fresh pair every round");
	});

	test("an option nobody set stays unset: `lifetime: undefined` must not defeat the default", async () => {
		// A caller that builds its options object by spreading - a pipeline runner,
		// an extension mapping tool arguments - produces `{ lifetime: undefined }`
		// for an option nobody filled in. Spread over a default, an explicit
		// `undefined` wins, and the pair silently loses its memory.
		const fake = approvesAt(3);
		await pair({ worker, reviewer, input: "x", lifetime: undefined, spawn: fake.spawn });

		assert.equal(fake.spawned.length, 2, "unset is not `task`: the team survives an undefined");
	});

	test("maxRounds below one is a programming error", async () => {
		await assert.rejects(() => pair({ worker, reviewer, input: "x", maxRounds: 0 }), /at least 1/);
	});
});

describe("pair, when the reviewer decides through the verdict tool", () => {
	const judge = testAgent("reviewer", { description: "Reviews code", tools: ["read", VERDICT_TOOL] });

	/** A reviewer that calls the tool at round `n`, and refuses before that. */
	const decidesAt = (n: number) => {
		let round = 0;
		return fakeSpawn(async (_task, agent, options) => {
			if (agent.name !== "reviewer") return { output: "work done" };
			round++;
			const tool = options.customTools?.[0];
			assert.ok(tool, "the reviewer is offered the tool it declared");
			await callTool(tool, round >= n ? { approved: true } : { approved: false, remarks: `round ${round}: short form` });
			return { output: `round ${round}: the parser drops the last token, src/parse.ts:12` };
		});
	};

	test("the tool call decides, and the prose beside it is not read", async () => {
		const fake = decidesAt(1);
		const result = await pair({ worker, reviewer: judge, input: "implement the parser", spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.deepEqual(result.verdict, { approved: true, remarks: undefined, resolved: [], raised: [] });
		assert.equal(result.rounds, 1);
	});

	test("the worker gets the review itself, not the verdict's summary of it", async () => {
		const fake = decidesAt(2);
		const result = await pair({ worker, reviewer: judge, input: "implement the parser", spawn: fake.spawn });

		assert.equal(result.approved, true);
		const toWorker = fake.asks.filter((ask) => ask.id.startsWith("coder"));
		const second = toWorker[1]?.task ?? "";
		assert.match(second, /src\/parse\.ts:12/, "the prose the reviewer's definition disciplines");
		assert.doesNotMatch(second, /short form/, "the tool carries the decision, not the argument for it");
	});

	test("the short form stays on the result, for whoever reads the outcome", async () => {
		const fake = decidesAt(99);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 1, spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.deepEqual(result.verdict, { approved: false, remarks: "round 1: short form", resolved: [], raised: [] });
	});

	test("only the reviewer is offered the tool", async () => {
		const fake = decidesAt(1);
		await pair({ worker, reviewer: judge, input: "x", spawn: fake.spawn });

		const offered = fake.spawned.map((one) => [one.agent, one.options.customTools?.length ?? 0]);
		assert.deepEqual(offered, [
			["coder", 0],
			["reviewer", 1],
		]);
	});

	test("a reviewer that calls nothing has not approved, and the result says it never decided", async () => {
		const fake = fakeSpawn((_task, agent) =>
			agent.name === "reviewer" ? { output: `Looks fine to me. ${APPROVAL}` } : { output: "work done" },
		);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 2, spawn: fake.spawn });

		assert.equal(result.approved, false, "prose is not a decision once the tool is the channel");
		assert.equal(result.verdict, undefined, "absent, not `approved: false`: it never answered");
		assert.equal(result.rounds, 2);
	});

	test("a reviewer that declares nothing keeps the word", async () => {
		const fake = approvesAt(1);
		const result = await pair({ worker, reviewer, input: "x", spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.equal(result.verdict, undefined);
		assert.deepEqual(result.obligations, []);
		assert.equal(fake.spawned[1]?.options.customTools, undefined);
	});
});

describe("pair, with a ledger of obligations", () => {
	const judge = testAgent("reviewer", { description: "Reviews code", tools: ["read", VERDICT_TOOL] });

	/** A reviewer driven round by round: what it raises, resolves, and decides. */
	const scripted = (rounds: Record<string, unknown>[]) => {
		let round = 0;
		return fakeSpawn(async (task, agent, options) => {
			if (agent.name !== "reviewer") return { output: "work done" };
			const tool = options.customTools?.[0];
			assert.ok(tool);
			await callTool(tool, rounds[round++] ?? { approved: true });
			return { output: `saw: ${task.slice(-120)}` };
		});
	};

	test("an obligation keeps its id across rounds, and is listed until it closes", async () => {
		const fake = scripted([
			{ approved: false, raised: ["the parser drops the last token"] },
			{ approved: true, resolved: [{ id: "o1", how: "addressed" }] },
		]);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 3, spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.equal(result.rounds, 2);
		assert.deepEqual(
			result.obligations.map((one) => [one.id, one.openedAt, one.closed?.at]),
			[["o1", 1, 2]],
		);

		const second = fake.asks.filter((ask) => ask.id.startsWith("reviewer"))[1]?.task ?? "";
		assert.match(second, /Still open, from your earlier rounds:\no1: the parser drops the last token/);
	});

	test("approving over an open obligation does not finish the work", async () => {
		const fake = scripted([
			{ approved: false, raised: ["one", "two"] },
			{ approved: true, resolved: [{ id: "o1", how: "addressed" }] },
		]);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 2, spawn: fake.spawn });

		assert.equal(result.verdict?.approved, true, "the reviewer said yes");
		assert.equal(result.approved, false, "and `o2` was still open, so the work is not finished");
		assert.deepEqual(
			result.obligations.filter((one) => !one.closed).map((one) => one.id),
			["o2"],
		);
	});

	test("a withdrawal closes it, and keeps the reason it was dropped for", async () => {
		const fake = scripted([
			{ approved: false, raised: ["the parser drops the last token"] },
			{ approved: true, resolved: [{ id: "o1", how: "withdrawn", reason: "the code already did it" }] },
		]);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 2, spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.deepEqual(result.obligations[0]?.closed, { how: "withdrawn", reason: "the code already did it", at: 2 });
	});

	test("an obligation a round does not name stays open, whatever else it says", async () => {
		const fake = scripted([{ approved: false, raised: ["one"] }, { approved: true }, { approved: true }]);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 3, spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.equal(result.rounds, 3, "three rounds spent on one line nobody answered for");
		assert.equal(result.obligations[0]?.closed, undefined);
	});

	test("an id the reviewer never raised closes nothing", async () => {
		const fake = scripted([
			{ approved: false, raised: ["one"] },
			{ approved: true, resolved: [{ id: "o7", how: "addressed" }] },
		]);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 2, spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.equal(result.obligations.length, 1, "a resolution naming nothing raises nothing either");
	});

	test("a round cannot raise and close the same obligation", async () => {
		const fake = scripted([{ approved: true, raised: ["one"], resolved: [{ id: "o1", how: "addressed" }] }]);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 1, spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.equal(result.obligations[0]?.closed, undefined, "closures are applied before anything new is raised");
	});
});
