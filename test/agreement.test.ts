/**
 * Counting votes off a board.
 *
 * The parser is lenient on purpose and the counter is strict on purpose, and
 * the two together are the whole stop condition: a vote written with the
 * emphasis a model adds still counts, and two members out of three agreeing
 * still does not.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agreed, latestVotes, VOTE_INSTRUCTION } from "../src/board/agreement.ts";
import { createBoard, type Board } from "../src/board/board.ts";

/** A board with the given posts on it, from the members that wrote them. */
function boardOf(...said: [from: string, text: string][]): Board {
	const board = createBoard();
	for (const [from, text] of said) board.post(from, { kind: "result", text });
	return board;
}

describe("latestVotes", () => {
	test("reads a vote through the decoration a model writes around it", () => {
		const votes = latestVotes(
			boardOf(
				["a", "VOTE: Rust\n\nNo garbage collector."],
				["b", "**VOTE: Rust**"],
				["c", "> vote : rust."],
			).all(),
		);
		assert.deepEqual([...votes.values()], ["rust", "rust", "rust"]);
	});

	test("the last vote of a member is the one that counts", () => {
		const votes = latestVotes(boardOf(["a", "VOTE: Go"], ["a", "VOTE: Rust"]).all());
		assert.deepEqual([...votes], [["a", "rust"]], "changing your mind is the thing being watched for");
	});

	test("the first vote line in a post is the member's own", () => {
		const votes = latestVotes(boardOf(["a", "VOTE: Go\n\nYou wrote VOTE: Rust, and here is why it is wrong."]).all());
		assert.deepEqual([...votes], [["a", "go"]], "quoting somebody else's vote is quoting, not voting");
	});

	test("a post with no vote line in it is not a vote", () => {
		assert.equal(latestVotes(boardOf(["a", "I would pivot to Rust"]).all()).size, 0);
	});
});

describe("agreed", () => {
	test("fires when everybody has voted for the same thing", () => {
		const board = boardOf(["a", "VOTE: Rust"], ["b", "VOTE: Rust"], ["c", "VOTE: Rust"]);
		assert.equal(agreed(3)(board), true);
	});

	test("two of three agreeing have not agreed", () => {
		const board = boardOf(["a", "VOTE: Rust"], ["b", "VOTE: Rust"]);
		assert.equal(agreed(3)(board), false, "a test on whoever spoke would stop at the first two that matched");
	});

	test("everybody voting, for different things, is not agreement", () => {
		const board = boardOf(["a", "VOTE: Rust"], ["b", "VOTE: Go"], ["c", "VOTE: Python"]);
		assert.equal(agreed(3)(board), false);
	});

	test("nobody has agreed on an empty board", () => {
		assert.equal(agreed(3)(createBoard()), false);
	});
});

test("the instruction says the word the parser reads", () => {
	assert.match(VOTE_INSTRUCTION, /`VOTE: <your answer>`/);
	const board = boardOf(["a", "VOTE: the format this instruction asks for"]);
	assert.equal(latestVotes(board.all()).size, 1, "told in one file and read in another, the two drift");
});
