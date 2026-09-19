/**
 * The swarm: what a round is, who drops out, and what happens to what they held.
 *
 * Offline, with a fake `spawn`. The members here do what they are told to do by
 * the fixture rather than what a model would decide, which is the point: what is
 * under test is the machinery around them, not their judgement.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBoard } from "../src/board.ts";
import { createClaims } from "../src/claims.ts";
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

	test("a member whose turn fails drops out and keeps the turn that failed", async () => {
		let asked = 0;
		// The second member to be asked breaks, once.
		const fake = fakeSpawn(() => (++asked === 2 ? { ok: false, error: "402 from the provider" } : {}));
		const done = await swarm({ members: [{ agent: member, count: 2 }], goal: "do it", rounds: 3, spawn: fake.spawn });

		assert.equal(fake.asks.length, 4, "two in the first round, then only the survivor");
		assert.equal(done.ok, false);
		assert.equal(done.error, "402 from the provider");
		assert.equal(done.members.filter((one) => !one.result.ok).length, 1);
	});

	test("when everybody has dropped out the swarm says so", async () => {
		const fake = fakeSpawn(() => ({ ok: false, error: "gone" }));
		const done = await swarm({ members: [{ agent: member, count: 2 }], goal: "do it", rounds: 3, spawn: fake.spawn });

		assert.equal(done.stoppedBy, "members");
		assert.equal(fake.asks.length, 2, "nobody is asked a second time");
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

	test("what is still free, when the caller said what there was", () => {
		const claims = createClaims({ keys: ["a", "b"] });
		claims.take("member#1", "a");

		assert.match(task("g", 1, [], claims), /Still free to take: b\./);
		assert.ok(!task("g", 1, [], createClaims()).includes("Still free"), "a board that cannot list the work says nothing about it");
	});
});
