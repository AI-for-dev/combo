/**
 * The swarm: what a round is, who drops out, and what happens to what they held.
 *
 * Offline, with a fake `spawn`. The members here do what they are told to do by
 * the fixture rather than what a model would decide, which is the point: what is
 * under test is the machinery around them, not their judgement.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOARD_TOOL } from "../src/board/tool.ts";
import { createBoard } from "../src/board/board.ts";
import { createClaims } from "../src/board/claims.ts";
import { swarm, task } from "../src/workflows/swarm.ts";
import { callTool } from "./fixtures/call-tool.ts";
import { fakeSpawn, offeredTools, testAgent } from "./fixtures/fake-subagent.ts";

const member = testAgent("member", { description: "one of several" });

describe("the roster", () => {
	test("count copies of an agent, each with its own id", async () => {
		const fake = fakeSpawn();
		const done = await swarm({ members: [{ agent: member, count: 3 }], goal: "do it", rounds: 1, spawn: fake.spawn });

		assert.equal(done.members.length, 3);
		assert.equal(new Set(done.members.map((one) => one.id)).size, 3, "three names, not one repeated");
	});

	test("a swarm with nobody on it is a mistake, not an empty result", async () => {
		await assert.rejects(() => swarm({ members: [], goal: "do it", spawn: fakeSpawn().spawn }), /at least one member/);
	});

	test("`rounds` below one is a mistake", async () => {
		const fake = fakeSpawn();
		await assert.rejects(() => swarm({ members: [{ agent: member, count: 1 }], goal: "x", rounds: 0, spawn: fake.spawn }), /at least 1/);
	});

	test('a "task" member cannot last two rounds: its name would change under it', async () => {
		const fake = fakeSpawn();
		await assert.rejects(
			() => swarm({ members: [{ agent: member, count: 2 }], goal: "x", rounds: 2, lifetime: "task", spawn: fake.spawn }),
			/new id each round/,
		);
	});
});

describe("a round", () => {
	test("is one ask per member, and members remember between them", async () => {
		const fake = fakeSpawn();
		const done = await swarm({ members: [{ agent: member, count: 3 }], goal: "do it", rounds: 2, spawn: fake.spawn });

		assert.equal(fake.asks.length, 6, "three members, two rounds");
		assert.equal(fake.spawned.length, 3, "and three sessions, not six");
		assert.equal(done.rounds, 2);
		assert.equal(done.stoppedBy, "rounds");
		assert.equal(done.converged, false, "reaching the cap is not success");
	});

	test("a member whose turn fails is asked again the next round, and is back if it recovers", async () => {
		let asked = 0;
		// The second member to be asked breaks, once: measured, a turn cut by the
		// output limit, which the next turn did not repeat.
		const fake = fakeSpawn(() => (++asked === 2 ? { ok: false, error: "the answer reached the output limit" } : {}));
		const done = await swarm({ members: [{ agent: member, count: 2 }], goal: "do it", rounds: 3, spawn: fake.spawn });

		assert.equal(fake.asks.length, 6, "both members, every round");
		assert.equal(done.ok, true, "its last turn is the one that counts");
	});

	test("two failed turns in a row and a member drops out, keeping the turn that failed", async () => {
		const flaky = testAgent("flaky", { description: "breaks every time" });
		const fake = fakeSpawn((_task, agent) => (agent.name === "flaky" ? { ok: false, error: "402 from the provider" } : {}));
		const done = await swarm({ members: [{ agent: member, count: 1 }, { agent: flaky, count: 1 }], goal: "do it", rounds: 3, spawn: fake.spawn });

		assert.deepEqual(
			fake.asks.map((one) => one.id),
			["member#1", "flaky#2", "member#1", "flaky#2", "member#1"],
			"asked once more after its first failure, then only the survivor",
		);
		assert.equal(done.ok, false);
		assert.equal(done.error, "402 from the provider");
		assert.equal(done.members.filter((one) => !one.result.ok).length, 1);
	});

	test("when everybody has dropped out the swarm says so", async () => {
		const fake = fakeSpawn(() => ({ ok: false, error: "gone" }));
		const done = await swarm({ members: [{ agent: member, count: 2 }], goal: "do it", rounds: 3, spawn: fake.spawn });

		assert.equal(done.stoppedBy, "members");
		assert.equal(fake.asks.length, 4, "each asked twice, and not a third time");
	});

	test("cancellation: a swarm already called off holds nobody, and says what stopped it", async () => {
		const fake = fakeSpawn();
		const done = await swarm({ members: [{ agent: member, count: 3 }], goal: "do it", rounds: 2, signal: AbortSignal.abort(), spawn: fake.spawn });

		assert.equal(fake.spawned.length, 0);
		assert.equal(done.stoppedBy, "signal");
		assert.equal(done.rounds, 0);
		assert.equal(done.ok, false);
		assert.equal(done.error, "never asked");
		assert.equal(done.members.length, 3, "the roster is reported, nobody on it was asked");
	});

	test("read as one Result: what every member said, under the name it posted under", async () => {
		const fake = fakeSpawn((task, agent) => ({ output: `${agent.name} on ${task.split("\n")[0]}` }));
		const done = await swarm({ members: [{ agent: member, count: 2 }], goal: "do it", rounds: 1, spawn: fake.spawn });

		assert.equal(done.output, "## member#1\n\nmember on do it\n\n## member#2\n\nmember on do it");
		assert.equal(done.agent, "member");
		assert.equal(done.steps.length, 2);
	});

	test("`until` ends it, and that is the only thing that counts as converged", async () => {
		const board = createBoard();
		const fake = fakeSpawn((_task, _agent, options) => {
			const tool = offeredTools(options)[0];
			if (tool) void callTool(tool, { action: "post", kind: "result", text: "done" });
			return {};
		});
		const done = await swarm({
			members: [{ agent: member, count: 1 }],
			goal: "do it",
			rounds: 5,
			board,
			until: (one) => one.all().some((post) => post.kind === "result"),
			spawn: fake.spawn,
		});

		assert.equal(done.converged, true);
		assert.equal(done.stoppedBy, "until");
		assert.equal(done.rounds, 1, "and it stopped at the round that reached it");
	});
});

describe("what a member is offered", () => {
	test("the board beside whatever the caller offered, in either shape the caller wrote it", async () => {
		const asList = fakeSpawn();
		await swarm({ members: [{ agent: member, count: 1 }], goal: "do it", rounds: 1, spawn: asList.spawn, customTools: () => [{ name: "hammer" } as never] });
		assert.deepEqual(offeredTools(asList.spawned[0]!.options, "member#1").map((tool) => tool.name), ["hammer", BOARD_TOOL]);

		const asFunction = fakeSpawn();
		await swarm({
			members: [{ agent: member, count: 1 }],
			goal: "do it",
			rounds: 1,
			spawn: asFunction.spawn,
			customTools: () => (id: string) => [{ name: `hammer-for-${id}` } as never],
		});
		assert.deepEqual(offeredTools(asFunction.spawned[0]!.options, "member#1").map((tool) => tool.name), ["hammer-for-member#1", BOARD_TOOL]);
	});
});

describe("the board", () => {
	test("a member posts under its own id, never another's", async () => {
		const board = createBoard();
		const fake = fakeSpawn(async (_task, _agent, options) => {
			const tool = offeredTools(options, "member#7")[0];
			if (tool) await callTool(tool, { action: "post", kind: "tell", text: "here", from: "somebody-else" });
			return {};
		});
		await swarm({ members: [{ agent: member, count: 1 }], goal: "do it", rounds: 1, board, spawn: fake.spawn });

		assert.equal(board.all()[0]?.from, "member#7");
	});

	test("what one member posted is in what the next is told", async () => {
		const board = createBoard();
		board.post("member#9", { kind: "tell", text: "the parser is in src/pipeline.ts" });
		const fake = fakeSpawn();
		await swarm({ members: [{ agent: member, count: 1 }], goal: "do it", rounds: 1, board, spawn: fake.spawn });

		assert.match(fake.asks[0]?.task ?? "", /the parser is in src\/pipeline\.ts/);
	});

	test("what a member was handed, its own `read` does not hand it again", async () => {
		const board = createBoard();
		board.post("member#9", { kind: "tell", text: "the parser is in src/pipeline.ts" });
		const reads: string[] = [];
		const fake = fakeSpawn(async (_task, _agent, options) => {
			const tool = offeredTools(options, "member#1")[0];
			if (tool) reads.push((await callTool(tool, { action: "read" })).content[0]?.text ?? "");
			return {};
		});
		await swarm({ members: [{ agent: member, count: 1 }], goal: "do it", rounds: 1, board, spawn: fake.spawn });

		assert.match(fake.asks[0]?.task ?? "", /src\/pipeline\.ts/);
		assert.deepEqual(reads, ["Nothing new on the board."]);
	});

	test("`resultsPerTurn` refuses a result past it, tells the member to end its turn, and starts over next turn", async () => {
		const board = createBoard();
		const said: string[] = [];
		let turn = 0;
		const fake = fakeSpawn(async (_task, _agent, options) => {
			const tool = offeredTools(options, "member#1")[0];
			turn++;
			for (const text of [`VOTE: Go (${turn})`, `VOTE: Go, still (${turn})`]) {
				said.push((await callTool(tool!, { action: "post", kind: "result", text })).content[0]?.text ?? "");
			}
			said.push((await callTool(tool!, { action: "post", kind: "tell", text: `thinking aloud (${turn})` })).content[0]?.text ?? "");
			return {};
		});
		await swarm({ members: [{ agent: member, count: 1 }], goal: "do it", rounds: 2, resultsPerTurn: 1, board, spawn: fake.spawn });

		assert.match(said[1] ?? "", /already posted your result for this turn as p1.*end your turn/s);
		assert.deepEqual(
			board.all().map((one) => one.kind),
			["result", "tell", "result", "tell"],
			"one result a turn, and a tell whenever it likes",
		);
	});

	test("`resultsPerTurn` below one is a mistake", async () => {
		await assert.rejects(
			() => swarm({ members: [{ agent: member, count: 1 }], goal: "x", resultsPerTurn: 0, spawn: fakeSpawn().spawn }),
			/resultsPerTurn.*at least 1/,
		);
	});

	test("the posts come back with the result, in order", async () => {
		const board = createBoard();
		board.post("member#9", { kind: "tell", text: "first" });
		const done = await swarm({ members: [{ agent: member, count: 1 }], goal: "x", rounds: 1, board, spawn: fakeSpawn().spawn });

		assert.deepEqual(
			done.posts.map((one) => one.text),
			["first"],
		);
	});
});

describe("what a member was holding", () => {
	test("is released when the swarm ends, and the result says what", async () => {
		const claims = createClaims({ keys: ["a", "b"] });
		const fake = fakeSpawn(async (_task, _agent, options) => {
			// The fake numbers its subagents as the real `spawn` does, so the tool
			// a member is handed is the one built with that member's own id.
			const tool = offeredTools(options, "member#1")[0];
			if (tool) await callTool(tool, { action: "take", key: "a" });
			return {};
		});
		const done = await swarm({ members: [{ agent: member, count: 1 }], goal: "x", rounds: 1, claims, spawn: fake.spawn });

		assert.deepEqual(
			done.claims.map((one) => `${one.key} ${one.heldBy} ${one.released}`),
			[`a ${done.members[0]?.id} true`],
		);
		assert.deepEqual(claims.open(), [], "and nobody is left holding anything");
	});

	test("two members cannot take the same thing", async () => {
		const claims = createClaims({ keys: ["a"] });
		const answers: string[] = [];
		let seat = 0;
		const fake = fakeSpawn(async (_task, _agent, options) => {
			const tool = offeredTools(options, `member#${++seat}`)[0];
			if (tool) answers.push((await callTool(tool, { action: "take", key: "a" })).content[0]?.text ?? "");
			return {};
		});
		await swarm({ members: [{ agent: member, count: 2 }], goal: "x", rounds: 1, claims, concurrency: 1, spawn: fake.spawn });

		assert.match(answers[0] ?? "", /a is yours/);
		assert.match(answers[1] ?? "", /held by member#1/);
	});
});

describe("what an observer sees", () => {
	test("board traffic reaches the listener the caller passed, not only a bus it did not pass", async () => {
		const claims = createClaims({ keys: ["a"] });
		const seen: string[] = [];
		const fake = fakeSpawn(async (_task, _agent, options) => {
			const tool = offeredTools(options, "member#1")[0];
			if (tool) {
				await callTool(tool, { action: "take", key: "a" });
				await callTool(tool, { action: "post", kind: "result", text: "done a" });
			}
			return {};
		});

		await swarm({
			members: [{ agent: member, count: 1 }],
			goal: "x",
			rounds: 1,
			claims,
			spawn: fake.spawn,
			onEvent: (event) => seen.push(event.type),
		});

		assert.ok(seen.includes("claim"), "a grant is as much of the run as a turn is");
		assert.ok(seen.includes("post"), "and so is what a member said");
		assert.equal(seen.filter((type) => type === "post").length, 1, "one listener, one bus: no event twice");
	});

	test("the handout that opens every round is on the stream, the empty one included", async () => {
		const board = createBoard();
		board.post("member#9", { kind: "tell", text: "news" });
		const reads: { id: string; posts: readonly string[] }[] = [];

		await swarm({
			members: [{ agent: member, count: 2 }],
			goal: "x",
			rounds: 1,
			board,
			concurrency: 1,
			spawn: fakeSpawn().spawn,
			onEvent: (event) => void (event.type === "read" && reads.push({ id: event.id, posts: event.posts })),
		});

		assert.deepEqual(reads, [
			{ id: "member#1", posts: ["p1"] },
			{ id: "member#2", posts: ["p1"] },
		]);
	});

	test("what a member was still holding when the swarm ended is given back on the stream", async () => {
		const claims = createClaims({ keys: ["a"] });
		const releases: unknown[] = [];
		const fake = fakeSpawn(async (_task, _agent, options) => {
			const tool = offeredTools(options, "member#1")[0];
			if (tool) await callTool(tool, { action: "take", key: "a" });
			return {};
		});

		await swarm({
			members: [{ agent: member, count: 1 }],
			goal: "x",
			rounds: 1,
			claims,
			spawn: fake.spawn,
			onEvent: (event) => void (event.type === "claim" && event.action === "release" && releases.push(event)),
		});

		assert.deepEqual(releases, [{ type: "claim", id: "member#1", key: "a", action: "release", ok: true }]);
	});
});

describe("with no board and no claims, one round", () => {
	test("a swarm is a fan-out: every member asked once, the goal and nothing else", async () => {
		const fake = fakeSpawn();
		const done = await swarm({ members: [{ agent: member, count: 3 }], goal: "describe the reporters", rounds: 1, spawn: fake.spawn });

		assert.equal(fake.asks.length, 3);
		for (const ask of fake.asks) assert.match(ask.task, /describe the reporters/);
		assert.deepEqual(done.posts, []);
		assert.deepEqual(done.claims, []);
		assert.equal(done.ok, true);
	});
});

describe("what a member is told", () => {
	test("the goal every round, the news only when there is some", () => {
		const claims = createClaims();
		const first = task("the goal", 1, [], claims);

		assert.match(first, /the goal/);
		assert.ok(!first.includes("on the board"), "nothing happened yet, so nothing is said about it");
		assert.match(first, /Take what you will work on/);
		assert.match(task("the goal", 2, [], claims), /Round 2/);
	});

	test("that what the others post comes to it next turn, so it has no reason to wait", () => {
		for (const round of [1, 2]) assert.match(task("g", round, [], createClaims()), /reaches you at the top of your next turn/);
	});

	test("what is still free, when the caller said what there was", () => {
		const claims = createClaims({ keys: ["a", "b"] });
		claims.take("member#1", "a");

		assert.match(task("g", 1, [], claims), /Still free to take: b\./);
		assert.ok(!task("g", 1, [], createClaims()).includes("Still free"), "a board that cannot list the work says nothing about it");
	});
});
