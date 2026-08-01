import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { beforeEach, describe, test } from "node:test";
import { resetSubagentIds } from "../src/events.ts";
import { run } from "../src/run.ts";
import { spawn } from "../src/subagent.ts";
import { fakeSession, fakeSessionFactory, type Turn } from "./fixtures/fake-session.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

const scout = testAgent("scout");

/** Spawns against a single scripted fake session. */
async function spawnWith(turns: Turn[], options: Parameters<typeof spawn>[1] = {}) {
	const session = fakeSession(turns);
	const subagent = await spawn(scout, { ...options, createSession: async () => session });
	return { subagent, session };
}

beforeEach(() => resetSubagentIds());

describe("spawn", () => {
	test('lifetime defaults to "task"', async () => {
		const { subagent } = await spawnWith([]);
		assert.equal(subagent.lifetime, "task");
	});

	test("an explicit lifetime beats the agent's frontmatter", async () => {
		const persistent = testAgent("reviewer", { lifetime: "workflow" });
		const subagent = await spawn(persistent, {
			lifetime: "task",
			createSession: async () => fakeSession([]),
		});
		assert.equal(subagent.lifetime, "task");
	});

	test("the frontmatter beats the default when nothing is passed", async () => {
		const persistent = testAgent("reviewer", { lifetime: "workflow" });
		const subagent = await spawn(persistent, { createSession: async () => fakeSession([]) });
		assert.equal(subagent.lifetime, "workflow");
	});

	test("openInHerdr resolves like lifetime: argument, then frontmatter, then false", async () => {
		const flag = async (agent: Parameters<typeof spawn>[0], options: Parameters<typeof spawn>[1] = {}) => {
			let seen: boolean | undefined;
			await spawn(agent, {
				...options,
				createSession: async () => fakeSession([]),
				onEvent: (event) => {
					if (event.type === "spawn") seen = event.openInHerdr;
				},
			});
			return seen;
		};

		const watched = testAgent("scout", { openInHerdr: true });
		assert.equal(await flag(testAgent("scout")), false, "default is off");
		assert.equal(await flag(watched), true, "frontmatter is honoured");
		assert.equal(await flag(watched, { openInHerdr: false }), false, "the explicit argument wins");
		assert.equal(await flag(testAgent("scout"), { openInHerdr: true }), true);
	});

	test("the model resolves like lifetime: argument, then frontmatter, then nothing", async () => {
		const asked = async (agent: Parameters<typeof spawn>[0], options: Parameters<typeof spawn>[1] = {}) => {
			const factory = fakeSessionFactory();
			await spawn(agent, { ...options, createSession: factory.createSession });
			return factory.requested[0]?.options.model;
		};

		const pinned = testAgent("scout", { model: "local/frontmatter" });
		assert.equal(await asked(testAgent("scout")), undefined, "no model anywhere leaves the choice to pi");
		assert.equal(await asked(pinned), "local/frontmatter", "frontmatter is honoured");
		assert.equal(await asked(pinned, { model: "local/override" }), "local/override", "the explicit argument wins");
		assert.equal(await asked(testAgent("scout"), { model: "local/override" }), "local/override");
	});

	test("ids are stable and per-agent", async () => {
		const a = await spawn(scout, { createSession: async () => fakeSession([]) });
		const b = await spawn(scout, { createSession: async () => fakeSession([]) });
		assert.equal(a.id, "scout#1");
		assert.equal(b.id, "scout#2");
	});
});

describe("ask", () => {
	test("returns the last assistant text", async () => {
		const { subagent } = await spawnWith([{ text: "found it in src/auth.ts" }]);
		const result = await subagent.ask("where is auth?");

		assert.equal(result.ok, true);
		assert.equal(result.output, "found it in src/auth.ts");
		assert.equal(result.agent, "scout");
	});

	test("result.usage is the delta of the turn, not the session total", async () => {
		const { subagent } = await spawnWith([
			{ text: "one", tokens: { input: 100, output: 20 }, cost: 0.01 },
			{ text: "two", tokens: { input: 60, output: 10 }, cost: 0.02 },
		]);

		const first = await subagent.ask("a");
		const second = await subagent.ask("b");

		assert.equal(first.usage.input, 100);
		// The fake accumulates like pi does: the raw total would read 160 here.
		assert.equal(second.usage.input, 60);
		assert.equal(second.usage.output, 10);
		assert.equal(second.usage.turns, 1);
	});

	test("subagent.usage accumulates across turns", async () => {
		const { subagent } = await spawnWith([
			{ tokens: { input: 100 }, cost: 0.01 },
			{ tokens: { input: 60 }, cost: 0.02 },
		]);

		await subagent.ask("a");
		await subagent.ask("b");

		assert.equal(subagent.usage.input, 160);
		assert.equal(subagent.usage.turns, 2);
		assert.ok(Math.abs(subagent.usage.cost - 0.03) < 1e-9);
	});

	test("wallMs keeps running between turns, busyMs does not", async () => {
		const { subagent } = await spawnWith([{ delayMs: 20 }]);
		await subagent.ask("a");
		await new Promise((resolve) => setTimeout(resolve, 40));

		const usage = subagent.usage;
		assert.ok(usage.busyMs >= 15, `busyMs=${usage.busyMs}`);
		assert.ok(usage.wallMs > usage.busyMs, `wallMs=${usage.wallMs} busyMs=${usage.busyMs}`);
	});

	test("a thrown prompt becomes ok:false, and keeps the tokens already spent", async () => {
		const { subagent } = await spawnWith([{ tokens: { input: 12_000 }, cost: 0.4, throws: "provider exploded" }]);

		const result = await subagent.ask("a");
		assert.equal(result.ok, false);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.usage.input, 12_000, "a subagent that died after 12k tokens still spent them");
		assert.ok(Math.abs(result.usage.cost - 0.4) < 1e-9);
	});

	test('a failing stopReason is a failure too, even without a throw', async () => {
		const { subagent } = await spawnWith([{ text: "partial", stopReason: "error" }]);
		const result = await subagent.ask("a");
		assert.equal(result.ok, false);
		assert.equal(result.error, "boom");
	});

	test("aborting the signal aborts the session", async () => {
		const { subagent, session } = await spawnWith([{ delayMs: 50, text: "never finished" }]);
		const controller = new AbortController();

		const pending = subagent.ask("a", { signal: controller.signal });
		setTimeout(() => controller.abort(), 5);
		const result = await pending;

		assert.equal(session.aborted, 1);
		assert.equal(result.ok, false);
		assert.equal(result.error, "aborted");
	});

	test("a shared signal does not accumulate listeners across turns", async () => {
		const { subagent } = await spawnWith([{}, {}, {}]);
		const controller = new AbortController();

		await subagent.ask("a", { signal: controller.signal });
		await subagent.ask("b", { signal: controller.signal });
		await subagent.ask("c", { signal: controller.signal });

		// Node warns past 10 listeners; three turns must leave none behind.
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	test("timeoutMs stops a turn that would never return", async () => {
		// pi's agent loop is a `while (true)`: without this guard, a model stuck
		// calling a tool it does not have loops forever.
		const { subagent, session } = await spawnWith([{ delayMs: 5_000, text: "never finished" }]);

		const startedAt = performance.now();
		const result = await subagent.ask("a", { timeoutMs: 20 });
		const elapsed = performance.now() - startedAt;

		assert.equal(session.aborted, 1);
		assert.equal(result.ok, false);
		assert.equal(result.error, "timed out after 20ms");
		// The point of the guard is that the turn *ends*, not that it is
		// labelled: a passing error message on a still-hanging turn is no guard.
		assert.ok(elapsed < 1_000, `the turn ran for ${elapsed.toFixed(0)}ms despite a 20ms deadline`);
	});

	test("a turn that finishes in time is untouched by the deadline", async () => {
		const { subagent, session } = await spawnWith([{ text: "quick" }]);
		const result = await subagent.ask("a", { timeoutMs: 10_000 });

		assert.equal(result.ok, true);
		assert.equal(result.output, "quick");
		assert.equal(session.aborted, 0);
	});

	test("the caller's signal wins over the deadline: the cause must not be confused", async () => {
		const { subagent } = await spawnWith([{ delayMs: 5_000 }]);
		const controller = new AbortController();

		// The caller aborts first; the deadline would have fired later.
		const pending = subagent.ask("a", { signal: controller.signal, timeoutMs: 3_000 });
		setTimeout(() => controller.abort(), 10);
		const result = await pending;

		assert.equal(result.ok, false);
		assert.equal(result.error, "aborted", "an explicit abort is a decision, not a deadline");
	});

	test("the deadline is per turn, not per subagent", async () => {
		const { subagent } = await spawnWith([{ delayMs: 30 }, { delayMs: 30 }]);

		// Each turn gets its own budget: two 30ms turns both fit under 100ms.
		const first = await subagent.ask("a", { timeoutMs: 100 });
		const second = await subagent.ask("b", { timeoutMs: 100 });

		assert.equal(first.ok, true);
		assert.equal(second.ok, true);
	});

	test("a timed-out turn still reports the tokens it spent", async () => {
		const { subagent } = await spawnWith([{ delayMs: 5_000, tokens: { input: 462_000 } }]);
		const result = await subagent.ask("a", { timeoutMs: 20 });

		assert.equal(result.ok, false);
		assert.equal(result.usage.turns, 1);
		assert.ok(result.usage.busyMs >= 15, `busyMs=${result.usage.busyMs}`);
	});

	test("concurrent asks on one subagent throw: a session has a single thread", async () => {
		const { subagent } = await spawnWith([{ delayMs: 30 }, {}]);
		const first = subagent.ask("a");
		await assert.rejects(() => subagent.ask("b"), /already working/);
		await first;
	});
});

describe("close", () => {
	test("disposes the session", async () => {
		const { subagent, session } = await spawnWith([]);
		await subagent.close();
		assert.equal(session.disposed, true);
	});

	test("is idempotent", async () => {
		const { subagent } = await spawnWith([]);
		await subagent.close();
		await subagent.close();
	});

	test("ask after close throws: that is a programming error, not a failed Result", async () => {
		const { subagent } = await spawnWith([]);
		await subagent.close();
		await assert.rejects(() => subagent.ask("a"), /is closed/);
	});

	// The close event is what every reporter draws its final state from. It used
	// to announce `ok: true` whatever had happened, so a 402 from the provider
	// was rendered `✓ explorer#1` with an empty output - "did not do the work"
	// read as "worked fine", in the one place nothing downstream catches it.
	test("the close event reports the failure of the last turn, not a green tick", async () => {
		const closes: { ok: boolean; error?: string }[] = [];
		const session = fakeSession([{ throws: "402 status code (no body)" }]);
		const subagent = await spawn(scout, {
			createSession: async () => session,
			onEvent: (event) => {
				if (event.type === "close") closes.push({ ok: event.result.ok, error: event.result.error });
			},
		});

		const result = await subagent.ask("a");
		await subagent.close();

		assert.equal(result.ok, false, "the Result already said so");
		assert.deepEqual(closes, [{ ok: false, error: "402 status code (no body)" }], "and so must the display");
	});

	test("a turn that failed then recovered closes green: the last turn is what counts", async () => {
		const closes: boolean[] = [];
		const session = fakeSession([{ throws: "boom" }, { text: "recovered" }]);
		const subagent = await spawn(testAgent("reviewer", { lifetime: "workflow" }), {
			createSession: async () => session,
			onEvent: (event) => {
				if (event.type === "close") closes.push(event.result.ok);
			},
		});

		assert.equal((await subagent.ask("a")).ok, false);
		assert.equal((await subagent.ask("b")).ok, true);
		await subagent.close();

		assert.deepEqual(closes, [true]);
	});

	test("a subagent nobody asked anything closes green: nothing failed", async () => {
		const closes: boolean[] = [];
		const subagent = await spawn(scout, {
			createSession: async () => fakeSession([]),
			onEvent: (event) => {
				if (event.type === "close") closes.push(event.result.ok);
			},
		});

		await subagent.close();
		assert.deepEqual(closes, [true]);
	});
});

describe("events", () => {
	test("emits spawn, tool, text, usage and close, in that order", async () => {
		const events: string[] = [];
		const session = fakeSession([{ text: "hello", tools: [{ name: "grep", args: { pattern: "x" } }] }]);
		const subagent = await spawn(scout, {
			createSession: async () => session,
			onEvent: (event) => events.push(event.type),
		});

		await subagent.ask("a");
		await subagent.close();

		assert.deepEqual(events, ["spawn", "status", "status", "tool", "text", "usage", "status", "status", "close"]);
	});

	test("a throwing reporter never breaks the turn", async () => {
		const session = fakeSession([{ text: "ok" }]);
		const subagent = await spawn(scout, {
			createSession: async () => session,
			onEvent: () => {
				throw new Error("broken reporter");
			},
		});

		const result = await subagent.ask("a");
		assert.equal(result.ok, true);
		await subagent.close();
	});
});

describe("run", () => {
	test("spawns, asks and closes in one call", async () => {
		const { createSession, created } = fakeSessionFactory([{ text: "done" }]);
		const result = await run(scout, "a task", { createSession });

		assert.equal(result.output, "done");
		assert.equal(created.length, 1);
		assert.equal(created[0]?.disposed, true);
	});

	test("closes the session even when the turn fails", async () => {
		const { createSession, created } = fakeSessionFactory([{ throws: "nope" }]);
		const result = await run(scout, "a task", { createSession });

		assert.equal(result.ok, false);
		assert.equal(created[0]?.disposed, true, "whoever opens, closes - failure included");
	});
});
