import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loop } from "../src/workflows/loop.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const coder = testAgent("coder");
const reviewer = testAgent("reviewer");

/** A reviewer that approves on the Nth iteration, counting its own turns. */
function approvesOnIteration(n: number) {
	let seen = 0;
	return (_task: string, agent: { name: string }) => {
		if (agent.name !== "reviewer") return {};
		seen++;
		return { output: seen >= n ? "LGTM" : `remark ${seen}` };
	};
}

const untilLgtm = (result: { output: string }) => result.output.includes("LGTM");

describe("loop", () => {
	test("feeds the last output back into the next iteration", async () => {
		const fake = fakeSpawn(approvesOnIteration(2));
		await loop({ steps: [coder, reviewer], input: "start", until: untilLgtm, spawn: fake.spawn });

		assert.deepEqual(
			fake.asks.map((ask) => ask.task),
			[
				"start", // coder, iteration 1
				"coder(start)", // reviewer sees the coder's work
				"remark 1", // coder receives the remarks - the whole point
				"coder(remark 1)", // reviewer sees the revised work
			],
		);
	});

	test("stops as soon as until is satisfied", async () => {
		const fake = fakeSpawn(approvesOnIteration(2));
		const result = await loop({
			steps: [coder, reviewer],
			input: "x",
			until: untilLgtm,
			maxIterations: 5,
			spawn: fake.spawn,
		});

		assert.equal(result.iterations, 2);
		assert.equal(result.converged, true);
		assert.equal(result.output, "LGTM");
		assert.equal(result.steps.length, 4);
	});

	test("until is judged on the last step, not on the coder's own opinion", async () => {
		// The coder claims LGTM; only the reviewer's verdict may end the loop.
		const fake = fakeSpawn((_task, agent) => ({ output: agent.name === "coder" ? "LGTM" : "not yet" }));
		const result = await loop({
			steps: [coder, reviewer],
			input: "x",
			until: untilLgtm,
			maxIterations: 2,
			spawn: fake.spawn,
		});

		assert.equal(result.converged, false);
		assert.equal(result.iterations, 2);
	});

	test("an async until is awaited: the judge is often a test run", async () => {
		const fake = fakeSpawn();
		let calls = 0;
		const result = await loop({
			steps: [coder],
			input: "x",
			until: async (_result, iteration) => {
				calls++;
				await new Promise((resolve) => setTimeout(resolve, 1));
				return iteration === 2;
			},
			spawn: fake.spawn,
		});

		assert.equal(calls, 2);
		assert.equal(result.iterations, 2);
		assert.equal(result.converged, true);
	});

	test("until receives the iteration number", async () => {
		const seen: number[] = [];
		await loop({
			steps: [coder],
			input: "x",
			until: (_result, iteration) => {
				seen.push(iteration);
				return iteration === 3;
			},
			spawn: fakeSpawn().spawn,
		});

		assert.deepEqual(seen, [1, 2, 3]);
	});

	describe("maxIterations", () => {
		test("caps the loop, and defaults to 5", async () => {
			const fake = fakeSpawn();
			const result = await loop({ steps: [coder], input: "x", until: () => false, spawn: fake.spawn });

			assert.equal(result.iterations, 5);
			assert.equal(fake.asks.length, 5);
		});

		test("hitting the cap is reported as not converged, even when every turn was fine", async () => {
			const result = await loop({
				steps: [coder],
				input: "x",
				until: () => false,
				maxIterations: 3,
				spawn: fakeSpawn().spawn,
			});

			assert.equal(result.ok, true, "no turn failed technically");
			assert.equal(result.converged, false, "but the work never reached the bar");
			assert.equal(result.iterations, 3);
		});

		test("without until, running the requested number of times is the goal", async () => {
			const fake = fakeSpawn();
			const result = await loop({ steps: [coder], input: "x", maxIterations: 3, spawn: fake.spawn });

			assert.equal(result.iterations, 3);
			assert.equal(result.converged, true);
			assert.equal(fake.asks.length, 3);
		});

		test("rejects a cap below 1: an unrunnable loop is a programming error", async () => {
			await assert.rejects(() => loop({ steps: [coder], input: "x", maxIterations: 0 }), /at least 1/);
		});

		test("rejects an empty step list", async () => {
			await assert.rejects(() => loop({ steps: [], input: "x" }), /`steps` is empty/);
		});
	});

	describe("lifetime", () => {
		test('"workflow": one subagent per distinct agent, alive across every iteration', async () => {
			const fake = fakeSpawn();
			await loop({
				steps: [coder, reviewer],
				input: "x",
				maxIterations: 3,
				lifetime: "workflow",
				spawn: fake.spawn,
			});

			assert.equal(fake.spawned.length, 2, "the reviewer of iteration 3 reviewed iteration 1");
			assert.equal(fake.asks.length, 6);
			const reviewerId = fake.spawned[1]!.id;
			assert.equal(fake.asks.filter((ask) => ask.id === reviewerId).length, 3);
		});

		test('"task": brand new subagents at every iteration, no accumulated bias', async () => {
			const fake = fakeSpawn();
			await loop({ steps: [coder, reviewer], input: "x", maxIterations: 3, lifetime: "task", spawn: fake.spawn });

			assert.equal(fake.spawned.length, 6);
			assert.equal(fake.closed.length, 6);
			assert.equal(new Set(fake.asks.map((ask) => ask.id)).size, 6);
		});

		test("the same scenario spawns a different number of subagents per lifetime", async () => {
			const asTask = fakeSpawn();
			const asWorkflow = fakeSpawn();
			const shared = { steps: [coder, reviewer], input: "x", maxIterations: 4 };

			await loop({ ...shared, lifetime: "task", spawn: asTask.spawn });
			await loop({ ...shared, lifetime: "workflow", spawn: asWorkflow.spawn });

			assert.equal(asTask.spawned.length, 8);
			assert.equal(asWorkflow.spawned.length, 2);
		});
	});

	describe("failure", () => {
		test("a failing step stops the loop and is returned as is", async () => {
			const fake = fakeSpawn((_task, agent) => (agent.name === "reviewer" ? { ok: false, error: "judge died" } : {}));
			const result = await loop({ steps: [coder, reviewer], input: "x", until: untilLgtm, spawn: fake.spawn });

			assert.equal(result.ok, false);
			assert.equal(result.error, "judge died");
			assert.equal(result.converged, false);
			assert.equal(result.iterations, 1);
			assert.equal(fake.asks.length, 2, "iteration 2 never started");
		});

		test("subagents are closed even when a step fails", async () => {
			const fake = fakeSpawn(() => ({ ok: false }));
			await loop({ steps: [coder], input: "x", lifetime: "workflow", spawn: fake.spawn });

			assert.deepEqual(
				fake.closed,
				fake.spawned.map((entry) => entry.id),
			);
		});
	});

	describe("cancellation", () => {
		test("an already-aborted signal runs nothing", async () => {
			const fake = fakeSpawn();
			const result = await loop({
				steps: [coder, reviewer],
				input: "x",
				signal: AbortSignal.abort(),
				spawn: fake.spawn,
			});

			assert.equal(result.ok, false);
			assert.equal(result.error, "aborted");
			assert.equal(result.converged, false);
			assert.equal(fake.asks.length, 0);
		});

		test("aborting mid-loop stops it and closes what was opened", async () => {
			const controller = new AbortController();
			const fake = fakeSpawn((_task, agent) => {
				if (agent.name === "reviewer") controller.abort();
				return {};
			});

			const result = await loop({
				steps: [coder, reviewer],
				input: "x",
				maxIterations: 5,
				lifetime: "workflow",
				signal: controller.signal,
				spawn: fake.spawn,
			});

			assert.equal(result.ok, false);
			assert.equal(fake.asks.length, 2, "iteration 2 never started");
			assert.deepEqual(
				fake.closed.sort(),
				fake.spawned.map((entry) => entry.id).sort(),
			);
		});
	});

	test("timeoutMs reaches every turn of every iteration", async () => {
		const fake = fakeSpawn();
		await loop({ steps: [coder, reviewer], input: "x", maxIterations: 2, timeoutMs: 45_000, spawn: fake.spawn });

		assert.equal(fake.askOptions.length, 4);
		assert.ok(fake.askOptions.every((options) => options.timeoutMs === 45_000));
	});
});
