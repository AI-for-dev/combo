import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pickDestination, route, routingPrompt } from "../src/workflows/route.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const router = testAgent("router", { description: "Picks who should handle a task" });
const coder = testAgent("coder", { description: "Writes and edits code" });
const scout = testAgent("scout", { description: "Finds where code lives" });
const destinations = [coder, scout];

/** Answers as the router, then echoes as the destination. */
const routerSays = (answer: string) => fakeSpawn((task, agent) => (agent.name === "router" ? { output: answer } : { output: `${agent.name} did it` }));

describe("route", () => {
	test("classifies, then hands the original task to the chosen agent", async () => {
		const fake = routerSays("scout");
		const result = await route({ router, destinations, input: "where is the parser?", spawn: fake.spawn });

		assert.equal(result.destination?.name, "scout");
		assert.equal(result.output, "scout did it");
		assert.equal(fake.asks[1]?.task, "where is the parser?", "the destination gets the task, not the routing prompt");
	});

	test("the classifier sees the destinations and their descriptions, never the routing of others", async () => {
		const fake = routerSays("coder");
		await route({ router, destinations, input: "add a flag", spawn: fake.spawn });

		const prompt = fake.asks[0]?.task ?? "";
		assert.match(prompt, /coder: Writes and edits code/);
		assert.match(prompt, /scout: Finds where code lives/);
		assert.match(prompt, /add a flag/);
	});

	test("steps hold the classification then the work", async () => {
		const fake = routerSays("coder");
		const result = await route({ router, destinations, input: "add a flag", spawn: fake.spawn });

		assert.deepEqual(
			result.steps.map((step) => step.agent),
			["router", "coder"],
		);
		assert.equal(result.routing.output, "coder");
	});

	test("an unroutable answer is a failed result naming what the router said", async () => {
		const fake = routerSays("I am not sure, perhaps someone else");
		const result = await route({ router, destinations, input: "x", spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.equal(result.destination, undefined);
		assert.match(result.error ?? "", /no destination matched/);
		assert.match(result.error ?? "", /not sure/, "the caller must see the answer that could not be read");
		assert.equal(fake.asks.length, 1, "nothing was picked, so nothing ran");
	});

	test("a fallback catches what the classifier could not decide", async () => {
		const fake = routerSays("no idea");
		const result = await route({ router, destinations, input: "x", fallback: scout, spawn: fake.spawn });

		assert.equal(result.destination?.name, "scout");
		assert.equal(result.ok, true);
	});

	test("a failing classifier stops the route: nothing is guessed", async () => {
		const fake = fakeSpawn((_task, agent) => (agent.name === "router" ? { ok: false, error: "provider exploded" } : {}));
		const result = await route({ router, destinations, input: "x", spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.equal(result.error, "provider exploded");
		assert.equal(fake.asks.length, 1);
	});

	test("no destination at all is a caller error", async () => {
		await assert.rejects(() => route({ router, destinations: [], input: "x" }), /nowhere to route to/);
	});

	test("cancellation: nothing is spawned", async () => {
		const fake = routerSays("coder");
		const result = await route({ router, destinations, input: "x", signal: AbortSignal.abort(), spawn: fake.spawn });

		assert.equal(fake.spawned.length, 0);
		assert.equal(result.error, "aborted");
	});

	test("everything opened is closed, whatever the route", async () => {
		const fake = routerSays("coder");
		await route({ router, destinations, input: "x", spawn: fake.spawn });

		assert.deepEqual(
			fake.closed.sort(),
			fake.spawned.map((entry) => entry.id).sort(),
		);
	});

	test("lifetime: a persistent route keeps its two subagents, a disposable one does not", async () => {
		// Routing twice through the same pool is what would show reuse - a single
		// route spawns the router and one destination either way. What the
		// lifetime decides is *when* they are closed, which the pool owns.
		const disposable = routerSays("coder");
		await route({ router, destinations, input: "x", spawn: disposable.spawn });

		const persistent = routerSays("coder");
		await route({ router, destinations, input: "x", lifetime: "workflow", spawn: persistent.spawn });

		assert.equal(disposable.spawned.length, 2);
		assert.equal(persistent.spawned.length, 2);
		assert.deepEqual(
			persistent.spawned.map((entry) => entry.options.lifetime),
			["workflow", "workflow"],
		);
		assert.equal(persistent.closed.length, 2, "whoever opens, closes - persistence is not an excuse");
	});

	test("a custom parser replaces the reading of the answer", async () => {
		const fake = routerSays("42");
		const result = await route({
			router,
			destinations,
			input: "x",
			parse: (output, all) => (output.trim() === "42" ? all[1] : undefined),
			spawn: fake.spawn,
		});

		assert.equal(result.destination?.name, "scout");
	});
});

describe("pickDestination", () => {
	test("takes the answer whole when that is all there is", () => {
		assert.equal(pickDestination("coder", destinations)?.name, "coder");
		assert.equal(pickDestination("  scout\n", destinations)?.name, "scout");
	});

	test("reads the last line, which is where a model puts its verdict", () => {
		assert.equal(pickDestination("Let me think about this.\n\ncoder", destinations)?.name, "coder");
		assert.equal(pickDestination("Reasoning…\nAnswer: scout", destinations)?.name, "scout");
	});

	test("falls back to the only name mentioned anywhere", () => {
		assert.equal(pickDestination("This clearly belongs to the coder, I think.", destinations)?.name, "coder");
	});

	test("refuses to guess between two names rather than picking the first", () => {
		assert.equal(pickDestination("It could be coder or scout, hard to say.", destinations), undefined);
	});

	test("matches whole words: coder is not found inside decoder", () => {
		assert.equal(pickDestination("ask the decoder", destinations), undefined);
	});

	test("nothing recognisable is undefined, never a default", () => {
		assert.equal(pickDestination("", destinations), undefined);
		assert.equal(pickDestination("I don't know", destinations), undefined);
	});
});

describe("routingPrompt", () => {
	test("lists the destinations and asks for a bare name", () => {
		const prompt = routingPrompt("do the thing", destinations);
		assert.match(prompt, /- coder: Writes and edits code/);
		assert.match(prompt, /agent name alone/);
		assert.ok(prompt.trim().endsWith("do the thing"), "the task comes last, closest to the answer");
	});
});
