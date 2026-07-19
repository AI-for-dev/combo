import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyUsage } from "../src/usage.ts";
import { aggregate, fanOut } from "../src/workflows/fan-out.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const scout = testAgent("scout");
const coder = testAgent("coder");

describe("fanOut", () => {
	test("returns one result per task, in the order of tasks", async () => {
		// Slowest first, so completion order and task order disagree.
		const fake = fakeSpawn((task) => ({ delayMs: task === "a" ? 30 : 1 }));
		const { results } = await fanOut({ agent: scout, tasks: ["a", "b", "c"], spawn: fake.spawn });

		assert.deepEqual(
			results.map((result) => result.output),
			["scout(a)", "scout(b)", "scout(c)"],
		);
	});

	test("accepts one agent per task", async () => {
		const fake = fakeSpawn();
		const { results } = await fanOut({ agents: [scout, coder], tasks: ["a", "b"], spawn: fake.spawn });

		assert.deepEqual(
			results.map((result) => result.agent),
			["scout", "coder"],
		);
	});

	test("rejects a mismatched agents/tasks length", async () => {
		await assert.rejects(() => fanOut({ agents: [scout], tasks: ["a", "b"] }), /1 agents for 2 tasks/);
	});

	test("rejects a fan-out with no agent at all", async () => {
		await assert.rejects(() => fanOut({ tasks: ["a"] }), /`agent` or `agents` is required/);
	});

	describe("concurrency", () => {
		test("never exceeds the bound", async () => {
			const fake = fakeSpawn(() => ({ delayMs: 20 }));
			await fanOut({ agent: scout, tasks: ["a", "b", "c", "d", "e"], concurrency: 2, spawn: fake.spawn });

			assert.equal(fake.maxConcurrent, 2);
		});

		test("actually runs in parallel: busyMs exceeds wallMs", async () => {
			const fake = fakeSpawn(() => ({ delayMs: 30, usage: { busyMs: 30, turns: 1 } }));
			const { usage } = await fanOut({ agent: scout, tasks: ["a", "b", "c"], concurrency: 3, spawn: fake.spawn });

			assert.equal(usage.busyMs, 90);
			assert.ok(usage.wallMs < usage.busyMs, `wallMs=${usage.wallMs} busyMs=${usage.busyMs}`);
		});

		test("defaults to 4", async () => {
			const fake = fakeSpawn(() => ({ delayMs: 20 }));
			await fanOut({ agent: scout, tasks: ["a", "b", "c", "d", "e", "f"], spawn: fake.spawn });
			assert.equal(fake.maxConcurrent, 4);
		});

		test("never opens more sessions than there are tasks", async () => {
			const fake = fakeSpawn();
			await fanOut({ agent: scout, tasks: ["a"], concurrency: 8, spawn: fake.spawn });
			assert.equal(fake.spawned.length, 1);
		});
	});

	describe("lifetime", () => {
		test('"task": one spawn per task, all closed', async () => {
			const fake = fakeSpawn();
			await fanOut({ agent: scout, tasks: ["a", "b", "c"], lifetime: "task", spawn: fake.spawn });

			assert.equal(fake.spawned.length, 3);
			assert.equal(fake.closed.length, 3);
		});

		test('"workflow": each branch keeps its own subagent - contexts never merge', async () => {
			const fake = fakeSpawn();
			await fanOut({ agent: scout, tasks: ["a", "b", "c"], lifetime: "workflow", concurrency: 1, spawn: fake.spawn });

			assert.equal(fake.spawned.length, 3, "same agent, but three isolated branches");
			const ids = new Set(fake.asks.map((ask) => ask.id));
			assert.equal(ids.size, 3);
		});
	});

	describe("failure", () => {
		test("a failing branch is isolated: the others finish", async () => {
			const fake = fakeSpawn((task) => (task === "b" ? { ok: false, error: "branch b died" } : {}));
			const { results } = await fanOut({ agent: scout, tasks: ["a", "b", "c"], spawn: fake.spawn });

			assert.deepEqual(
				results.map((result) => result.ok),
				[true, false, true],
			);
			assert.equal(results[1]?.error, "branch b died");
		});

		test("a failed branch keeps its tokens in the aggregate", async () => {
			const fake = fakeSpawn((task) =>
				task === "a" ? { ok: false, usage: { input: 12_000, turns: 1 } } : { usage: { input: 500, turns: 1 } },
			);
			const { usage } = await fanOut({ agent: scout, tasks: ["a", "b"], spawn: fake.spawn });

			assert.equal(usage.input, 12_500);
			assert.equal(usage.turns, 2);
		});

		test("failFast stops the branches that had not started", async () => {
			const fake = fakeSpawn((task) => ({ ok: task === "a" ? false : true, delayMs: 5 }));
			const { results } = await fanOut({
				agent: scout,
				tasks: ["a", "b", "c", "d"],
				concurrency: 1,
				failFast: true,
				spawn: fake.spawn,
			});

			assert.equal(results[0]?.ok, false);
			assert.equal(fake.asks.length, 1, "nothing ran after the failure");
			assert.deepEqual(
				results.slice(1).map((result) => result.error),
				["aborted", "aborted", "aborted"],
			);
		});
	});

	test("timeoutMs reaches every branch", async () => {
		const fake = fakeSpawn();
		await fanOut({ agent: scout, tasks: ["a", "b", "c"], timeoutMs: 5_000, spawn: fake.spawn });

		assert.deepEqual(
			fake.askOptions.map((options) => options.timeoutMs),
			[5_000, 5_000, 5_000],
		);
	});

	describe("cancellation", () => {
		test("an already-aborted signal runs nothing but still fills every slot", async () => {
			const fake = fakeSpawn();
			const { results } = await fanOut({
				agent: scout,
				tasks: ["a", "b"],
				signal: AbortSignal.abort(),
				spawn: fake.spawn,
			});

			assert.equal(fake.asks.length, 0);
			assert.deepEqual(
				results.map((result) => result.error),
				["aborted", "aborted"],
			);
		});

		test("everything opened is closed, cancellation included", async () => {
			const controller = new AbortController();
			const fake = fakeSpawn(() => {
				controller.abort();
				return {};
			});

			await fanOut({
				agent: scout,
				tasks: ["a", "b", "c"],
				concurrency: 1,
				signal: controller.signal,
				lifetime: "workflow",
				spawn: fake.spawn,
			});

			assert.deepEqual(
				fake.closed.sort(),
				fake.spawned.map((entry) => entry.id).sort(),
			);
		});
	});
});

describe("exports", () => {
	test("exportDir reaches every branch, and a cancelled fan-out still exports what it opened", async () => {
		const controller = new AbortController();
		const fake = fakeSpawn((task) => {
			if (task === "a") controller.abort();
			return {};
		});

		await fanOut({
			agent: scout,
			tasks: ["a", "b", "c"],
			concurrency: 1,
			signal: controller.signal,
			exportDir: "/tmp/run",
			spawn: fake.spawn,
		});

		assert.ok(fake.spawned.length > 0 && fake.spawned.length < 3, "the abort stopped the fan-out mid-way");
		assert.ok(
			fake.spawned.every((entry) => entry.options.exportDir === "/tmp/run"),
			"every branch that did start knows where to write",
		);
		// Whoever opens, closes - and closing is what exports.
		assert.deepEqual(
			fake.exported.map((entry) => entry.id).sort(),
			fake.spawned.map((entry) => entry.id).sort(),
		);
	});

	test("nothing is exported when no directory was asked for", async () => {
		const fake = fakeSpawn();
		await fanOut({ agent: scout, tasks: ["a", "b"], spawn: fake.spawn });
		assert.deepEqual(fake.exported, []);
	});
});

describe("aggregate", () => {
	test("sums the branches over the real elapsed time", async () => {
		const usage = aggregate(
			[
				{ agent: "a", output: "", messages: [], ok: true, usage: { ...emptyUsage(), busyMs: 500, input: 10, turns: 1 } },
				{ agent: "b", output: "", messages: [], ok: true, usage: { ...emptyUsage(), busyMs: 400, input: 20, turns: 1 } },
			],
			600,
		);

		assert.equal(usage.busyMs, 900);
		assert.equal(usage.wallMs, 600);
		assert.equal(usage.input, 30);
	});
});
