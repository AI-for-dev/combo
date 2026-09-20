import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SubagentPool } from "../src/workflows/pool.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const coder = testAgent("coder");
const reviewer = testAgent("reviewer");

describe("SubagentPool", () => {
	describe("turn", () => {
		test("asks the agent and gives back what it said", async () => {
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn });

			const result = await pool.turn(coder, "write it");

			assert.equal(result.ok, true);
			assert.equal(result.output, "coder(write it)");
			assert.deepEqual(fake.asks, [{ id: "coder#1", task: "write it" }]);
		});

		test("carries the workflow's signal and deadline on every turn", async () => {
			const controller = new AbortController();
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn, signal: controller.signal, timeoutMs: 30_000 });

			await pool.turn(coder, "a");
			await pool.turn(reviewer, "b");

			assert.equal(fake.askOptions.length, 2);
			assert.ok(fake.askOptions.every((options) => options.signal === controller.signal && options.timeoutMs === 30_000));
		});

		test("an already-aborted signal is answered without spawning anything", async () => {
			const controller = new AbortController();
			controller.abort();
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn, signal: controller.signal });

			const result = await pool.turn(coder, "x");

			assert.equal(fake.spawned.length, 0);
			assert.deepEqual({ ok: result.ok, agent: result.agent, error: result.error }, { ok: false, agent: "coder", error: "aborted" });
		});

		test("gives the subagent back even when the turn throws", async () => {
			const fake = fakeSpawn(() => {
				throw new Error("the model fell over");
			});
			const pool = new SubagentPool({ spawn: fake.spawn });

			await assert.rejects(pool.turn(coder, "x"), /fell over/);
			assert.deepEqual(fake.closed, ["coder#1"]);
		});
	});

	describe("lifetime", () => {
		test('"task": a fresh subagent per turn, closed as soon as the turn is over', async () => {
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn });

			await pool.turn(coder, "a");
			assert.deepEqual(fake.closed, ["coder#1"]);
			await pool.turn(coder, "b");

			assert.deepEqual(
				fake.spawned.map((entry) => entry.id),
				["coder#1", "coder#2"],
			);
			assert.deepEqual(fake.closed, ["coder#1", "coder#2"]);
		});

		test('"workflow": one subagent per key, reused, closed by closeAll', async () => {
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn, lifetime: "workflow" });

			await pool.turn(coder, "a");
			await pool.turn(coder, "b");
			await pool.turn(reviewer, "c");
			assert.deepEqual(fake.closed, []);

			await pool.closeAll();

			assert.deepEqual(
				fake.spawned.map((entry) => entry.id),
				["coder#1", "reviewer#2"],
			);
			assert.deepEqual(
				fake.asks.map((ask) => ask.id),
				["coder#1", "coder#1", "reviewer#2"],
			);
			assert.deepEqual(fake.closed.sort(), ["coder#1", "reviewer#2"]);
		});

		test("the key decides who shares a memory, not the agent", async () => {
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn, lifetime: "workflow" });

			await pool.turn(coder, "a", { key: "coder#0" });
			await pool.turn(coder, "b", { key: "coder#1" });
			await pool.turn(coder, "c", { key: "coder#0" });

			assert.equal(fake.spawned.length, 2);
			assert.deepEqual(
				fake.asks.map((ask) => ask.id),
				["coder#1", "coder#2", "coder#1"],
			);
			await pool.closeAll();
		});

		test("the spawn is handed what the workflow was given, and the agent's own tools", async () => {
			const fake = fakeSpawn();
			const tool = { name: "verdict" } as never;
			const pool = new SubagentPool({
				spawn: fake.spawn,
				cwd: "/work",
				model: "local/sweep",
				exportDir: "/exports",
				parentId: "parent#1",
				customTools: (agent) => (agent.name === "reviewer" ? [tool] : undefined),
			});

			await pool.turn(coder, "a");
			await pool.turn(reviewer, "b");

			const [first, second] = fake.spawned.map((entry) => entry.options);
			assert.equal(first?.cwd, "/work");
			assert.equal(first?.model, "local/sweep");
			assert.equal(first?.exportDir, "/exports");
			assert.equal(first?.parentId, "parent#1");
			assert.equal(first?.lifetime, "task");
			assert.equal(first?.customTools, undefined);
			assert.deepEqual(second?.customTools, [tool]);
		});
	});

	describe("hold", () => {
		test("a held subagent answers several turns and lives until closeAll, whatever the lifetime", async () => {
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn, timeoutMs: 5_000 });

			const held = await pool.hold(coder);
			await held.ask("first");
			await held.ask("second");

			assert.equal(held.id, "coder#1");
			assert.equal(fake.spawned.length, 1);
			assert.deepEqual(
				fake.asks.map((ask) => ask.task),
				["first", "second"],
			);
			assert.ok(fake.askOptions.every((options) => options.timeoutMs === 5_000));
			assert.deepEqual(fake.closed, []);

			await pool.closeAll();
			assert.deepEqual(fake.closed, ["coder#1"]);
		});

		test("two holds of one agent under different keys are two subagents", async () => {
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn, lifetime: "workflow" });

			const [one, two] = await Promise.all([pool.hold(coder, { key: "coder@0" }), pool.hold(coder, { key: "coder@1" })]);

			assert.notEqual(one.id, two.id);
			await pool.closeAll();
			assert.equal(fake.closed.length, 2);
		});
	});

	describe("closeAll", () => {
		test("closes everything it opened, and a close that fails does not stop the others", async () => {
			const fake = fakeSpawn();
			const failing = async (...args: Parameters<typeof fake.spawn>) => {
				const subagent = await fake.spawn(...args);
				if (subagent.id === "coder#1") subagent.close = async () => Promise.reject(new Error("disk full"));
				return subagent;
			};
			const pool = new SubagentPool({ spawn: failing, lifetime: "workflow" });

			await pool.turn(coder, "a");
			await pool.turn(reviewer, "b");
			await pool.closeAll();

			assert.deepEqual(fake.closed, ["reviewer#2"]);
		});

		test("is idempotent: a second call closes nothing twice", async () => {
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn, lifetime: "workflow" });

			await pool.turn(coder, "a");
			await pool.closeAll();
			await pool.closeAll();

			assert.deepEqual(fake.closed, ["coder#1"]);
		});
	});
});
