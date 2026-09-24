import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SubagentPool } from "../src/workflows/pool.ts";
import { Trail } from "../src/workflows/trail.ts";
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

		test("every turn is on the trail, and what they cost is summed there", async () => {
			const fake = fakeSpawn(() => ({ usage: { input: 100 } }));
			const pool = new SubagentPool({ spawn: fake.spawn });

			const first = await pool.turn(coder, "a");
			const second = await pool.turn(reviewer, "b");

			assert.deepEqual(pool.trail.steps, [first, second]);
			assert.equal(pool.trail.usage().input, 200);
			assert.equal(pool.trail.usage().turns, 2);
		});

		test("a refused turn is a step on the trail too: a run that was called off says so", async () => {
			const pool = new SubagentPool({ spawn: fakeSpawn().spawn, signal: AbortSignal.abort() });

			await pool.turn(coder, "x");

			assert.equal(pool.trail.steps.length, 1);
			assert.equal(pool.trail.broken()?.error, "aborted");
		});

		test("records into the trail it is given, so a caller's clock can start before the pool", async () => {
			const trail = new Trail();
			const pool = new SubagentPool({ spawn: fakeSpawn().spawn }, trail);

			await pool.turn(coder, "a");

			assert.equal(pool.trail, trail);
			assert.equal(trail.steps.length, 1);
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

		test("an agent's frontmatter lifetime holds when the workflow names none", async () => {
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn });
			const remembering = testAgent("coder", { lifetime: "workflow" });

			await pool.turn(remembering, "a");
			await pool.turn(remembering, "b");
			await pool.turn(reviewer, "c");
			await pool.turn(reviewer, "d");
			assert.deepEqual(fake.closed, ["reviewer#2", "reviewer#3"]);

			await pool.closeAll();

			assert.deepEqual(
				fake.spawned.map((entry) => [entry.id, entry.options.lifetime]),
				[
					["coder#1", "workflow"],
					["reviewer#2", "task"],
					["reviewer#3", "task"],
				],
			);
			assert.deepEqual(fake.closed, ["reviewer#2", "reviewer#3", "coder#1"]);
		});

		test("the workflow's lifetime beats the frontmatter's, both ways", async () => {
			const fresh = fakeSpawn();
			const kept = fakeSpawn();
			const remembering = testAgent("coder", { lifetime: "workflow" });
			const forgetting = testAgent("coder", { lifetime: "task" });

			const asTask = new SubagentPool({ spawn: fresh.spawn, lifetime: "task" });
			await asTask.turn(remembering, "a");
			await asTask.turn(remembering, "b");
			const asWorkflow = new SubagentPool({ spawn: kept.spawn, lifetime: "workflow" });
			await asWorkflow.turn(forgetting, "a");
			await asWorkflow.turn(forgetting, "b");
			await asWorkflow.closeAll();

			assert.equal(fresh.spawned.length, 2);
			assert.equal(kept.spawned.length, 1);
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

		test("a held subagent's turns are on the trail like any other", async () => {
			const fake = fakeSpawn(() => ({ usage: { input: 50 } }));
			const pool = new SubagentPool({ spawn: fake.spawn });

			const held = await pool.hold(coder);
			await held.ask("first");
			await held.ask("second");

			assert.equal(pool.trail.steps.length, 2);
			assert.equal(pool.trail.usage().input, 100);
			await pool.closeAll();
		});

		test("an already-aborted signal is refused before the spawn, and every ask says so", async () => {
			const fake = fakeSpawn();
			const pool = new SubagentPool({ spawn: fake.spawn, signal: AbortSignal.abort() });

			const held = await pool.hold(coder, { key: "coder@2" });
			const answer = await held.ask("x");

			assert.equal(fake.spawned.length, 0);
			assert.equal(held.id, "coder@2", "addressed by its key, since no subagent exists to be named after");
			assert.deepEqual({ ok: answer.ok, agent: answer.agent, error: answer.error }, { ok: false, agent: "coder", error: "aborted" });
			assert.equal(pool.trail.broken(), answer);
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
