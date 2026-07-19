import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chain } from "../src/workflows/chain.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const coder = testAgent("coder");
const reviewer = testAgent("reviewer");

describe("chain", () => {
	test("feeds each step the previous output", async () => {
		const fake = fakeSpawn();
		const result = await chain({ steps: [coder, reviewer], input: "start", spawn: fake.spawn });

		assert.deepEqual(
			fake.asks.map((ask) => ask.task),
			["start", "coder(start)"],
		);
		assert.equal(result.output, "reviewer(coder(start))");
		assert.equal(result.ok, true);
		assert.equal(result.steps.length, 2);
	});

	test("rejects an empty chain: that is a programming error", async () => {
		await assert.rejects(() => chain({ steps: [], input: "x" }), /`steps` is empty/);
	});

	describe("lifetime", () => {
		test('"task": one spawn per step, closed as it goes', async () => {
			const fake = fakeSpawn();
			await chain({ steps: [coder, reviewer, coder], input: "x", lifetime: "task", spawn: fake.spawn });

			assert.equal(fake.spawned.length, 3);
			assert.equal(fake.closed.length, 3);
		});

		test('"workflow": one spawn per distinct agent, reused when it comes back', async () => {
			const fake = fakeSpawn();
			await chain({ steps: [coder, reviewer, coder], input: "x", lifetime: "workflow", spawn: fake.spawn });

			assert.equal(fake.spawned.length, 2, "coder is spawned once and reused");
			assert.deepEqual(
				fake.spawned.map((entry) => entry.agent),
				["coder", "reviewer"],
			);
			// The same coder saw both of its turns: its memory carried over.
			const coderId = fake.spawned[0]!.id;
			assert.equal(fake.asks.filter((ask) => ask.id === coderId).length, 2);
		});

		test("the same scenario spawns a different number of subagents per lifetime", async () => {
			const asTask = fakeSpawn();
			const asWorkflow = fakeSpawn();
			const steps = [coder, reviewer, coder, reviewer];

			await chain({ steps, input: "x", lifetime: "task", spawn: asTask.spawn });
			await chain({ steps, input: "x", lifetime: "workflow", spawn: asWorkflow.spawn });

			assert.equal(asTask.spawned.length, 4);
			assert.equal(asWorkflow.spawned.length, 2);
		});
	});

	describe("failure", () => {
		test("a failing step stops the chain and is returned as is", async () => {
			const fake = fakeSpawn((_task, agent) => (agent.name === "coder" ? { ok: false, error: "no compiler" } : {}));
			const result = await chain({ steps: [coder, reviewer], input: "x", spawn: fake.spawn });

			assert.equal(result.ok, false);
			assert.equal(result.error, "no compiler");
			assert.equal(result.steps.length, 1, "the reviewer never ran: it had no input");
			assert.equal(fake.asks.length, 1);
		});

		test("the workflow never throws on a step failure", async () => {
			const fake = fakeSpawn(() => ({ ok: false }));
			const result = await chain({ steps: [coder], input: "x", spawn: fake.spawn });
			assert.equal(result.ok, false);
		});

		test("subagents are closed even when a step fails", async () => {
			const fake = fakeSpawn(() => ({ ok: false }));
			await chain({ steps: [coder], input: "x", lifetime: "workflow", spawn: fake.spawn });
			assert.deepEqual(fake.closed, [fake.spawned[0]!.id]);
		});
	});

	test("timeoutMs reaches every step, as a per-step budget", async () => {
		const fake = fakeSpawn();
		await chain({ steps: [coder, reviewer], input: "x", timeoutMs: 30_000, spawn: fake.spawn });

		assert.deepEqual(
			fake.askOptions.map((options) => options.timeoutMs),
			[30_000, 30_000],
		);
	});

	describe("cancellation", () => {
		test("an already-aborted signal runs nothing", async () => {
			const fake = fakeSpawn();
			const result = await chain({
				steps: [coder, reviewer],
				input: "x",
				signal: AbortSignal.abort(),
				spawn: fake.spawn,
			});

			assert.equal(result.ok, false);
			assert.equal(result.error, "aborted");
			assert.equal(fake.asks.length, 0);
		});

		test("aborting mid-chain stops it and closes what was opened", async () => {
			const controller = new AbortController();
			const fake = fakeSpawn(() => {
				controller.abort();
				return {};
			});

			const result = await chain({
				steps: [coder, reviewer],
				input: "x",
				signal: controller.signal,
				lifetime: "workflow",
				spawn: fake.spawn,
			});

			assert.equal(result.ok, false);
			assert.equal(fake.asks.length, 1, "the second step never started");
			assert.deepEqual(fake.closed, fake.spawned.map((entry) => entry.id));
		});
	});

	test("every subagent shares one bus, so a reporter sees the whole workflow", async () => {
		const fake = fakeSpawn();
		const seen: string[] = [];
		await chain({
			steps: [coder, reviewer],
			input: "x",
			spawn: fake.spawn,
			cwd: "/somewhere",
			onEvent: (event) => seen.push(event.type),
		});

		const buses = new Set(fake.spawned.map((entry) => entry.options.bus));
		assert.equal(buses.size, 1);
		assert.notEqual([...buses][0], undefined);

		// The bus carries the listener the caller gave us.
		[...buses][0]!.emit({ type: "status", id: "x#1", status: "done" });
		assert.deepEqual(seen, ["status"]);

		// And the run settings reach every subagent.
		assert.deepEqual(
			fake.spawned.map((entry) => entry.options.cwd),
			["/somewhere", "/somewhere"],
		);
	});
});
