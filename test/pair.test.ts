import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { APPROVAL, pair } from "../src/workflows/pair.ts";
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
