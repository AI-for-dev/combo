import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stopSwitch } from "../src/stop.ts";
import { fanOut } from "../src/workflows/fan-out.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";
import { waitFor } from "./fixtures/wait-for.ts";

const scout = testAgent("scout");

describe("stopSwitch", () => {
	test("one() stops that branch and leaves the others working", async () => {
		const fake = fakeSpawn(() => ({ delayMs: 50 }));
		const stop = stopSwitch({ spawn: fake.spawn });

		const pending = fanOut({ agent: scout, tasks: ["a", "b", "c"], spawn: stop.spawn, signal: stop.signal });
		await waitFor(() => fake.spawned.length === 3);
		stop.one("scout#2");
		const { results } = await pending;

		assert.deepEqual(
			results.map((result) => result.ok),
			[true, false, true],
		);
		assert.equal(results[1]?.error, "stopped");
	});

	test("one() says when it has never seen that id", () => {
		const stop = stopSwitch({ spawn: fakeSpawn().spawn });
		assert.equal(stop.one("ghost#9"), false);
	});

	test("all() stops the turns in flight and the ones not started yet", async () => {
		const fake = fakeSpawn(() => ({ delayMs: 50 }));
		const stop = stopSwitch({ spawn: fake.spawn });

		const pending = fanOut({
			agent: scout,
			tasks: ["a", "b", "c", "d"],
			concurrency: 2,
			spawn: stop.spawn,
			signal: stop.signal,
		});
		await waitFor(() => fake.spawned.length === 2);
		stop.all();
		const { results } = await pending;

		assert.deepEqual(
			results.map((result) => result.ok),
			[false, false, false, false],
		);
		assert.equal(fake.spawned.length, 2, "a stopped run must not open the sessions it had not opened yet");
	});

	test("an outer signal stops the run, so a tool call cancelled by pi stops it too", async () => {
		const fake = fakeSpawn(() => ({ delayMs: 50 }));
		const outer = new AbortController();
		const stop = stopSwitch({ spawn: fake.spawn, signal: outer.signal });

		const pending = fanOut({ agent: scout, tasks: ["a"], spawn: stop.spawn, signal: stop.signal });
		await waitFor(() => fake.spawned.length === 1);
		outer.abort();
		const { results } = await pending;

		assert.equal(results[0]?.ok, false);
	});

	test("a switch built on an already aborted signal starts stopped", async () => {
		const fake = fakeSpawn();
		const stop = stopSwitch({ spawn: fake.spawn, signal: AbortSignal.abort() });

		const { results } = await fanOut({ agent: scout, tasks: ["a"], spawn: stop.spawn, signal: stop.signal });

		assert.equal(results[0]?.ok, false);
		assert.equal(fake.spawned.length, 0);
	});

	test("the subagents are closed, stopped or not: whoever opens still closes", async () => {
		const fake = fakeSpawn(() => ({ delayMs: 20 }));
		const stop = stopSwitch({ spawn: fake.spawn });

		const pending = fanOut({ agent: scout, tasks: ["a", "b"], spawn: stop.spawn, signal: stop.signal });
		await waitFor(() => fake.spawned.length === 2);
		stop.all();
		await pending;

		assert.deepEqual(fake.closed, ["scout#1", "scout#2"]);
	});
});
