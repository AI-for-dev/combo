/**
 * What a swarm member is told each turn: the goal, the news, what is free, and
 * that there is no reason to wait.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createClaims } from "../src/board/claims.ts";
import { swarmTask } from "../src/workflows/swarm-task.ts";

describe("what a member is told", () => {
	test("the goal every round, the news only when there is some", () => {
		const claims = createClaims();
		const first = swarmTask("the goal", 1, [], claims);

		assert.match(first, /the goal/);
		assert.ok(!first.includes("on the board"), "nothing happened yet, so nothing is said about it");
		assert.match(first, /Take what you will work on/);
		assert.match(swarmTask("the goal", 2, [], claims), /Round 2/);
	});

	test("what answers it first, when the swarm says who it is", () => {
		const answer = { id: "p2", from: "member#2", kind: "tell", text: "no", at: 0, re: { id: "p1", from: "member#1" } } as const;
		const aside = { id: "p3", from: "member#3", kind: "tell", text: "aside", at: 0 } as const;

		assert.match(swarmTask("g", 2, [aside, answer], createClaims(), "member#1"), /Answering you:\np2 member#2 re p1 \(member#1\) \[tell\] no\n\nThe rest:\np3/);
	});

	test("that what the others post comes to it next turn, so it has no reason to wait", () => {
		for (const round of [1, 2]) assert.match(swarmTask("g", round, [], createClaims()), /reaches you at the top of your next turn/);
	});

	test("what is still free, when the caller said what there was", () => {
		const claims = createClaims({ keys: ["a", "b"] });
		claims.take("member#1", "a");

		assert.match(swarmTask("g", 1, [], claims), /Still free to take: b\./);
		assert.ok(!swarmTask("g", 1, [], createClaims()).includes("Still free"), "a board that cannot list the work says nothing about it");
	});
});
