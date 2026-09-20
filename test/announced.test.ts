/**
 * What a board and a set of claims announce, whoever acts on them.
 *
 * The record is the point of the medium: posts say who said what, reads say
 * who knew what, and grants say who held what. All of it here, once, through
 * the wrapped medium - the tool and the swarm both act on the wrapped one.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { announcedBoard, announcedClaims } from "../src/announced.ts";
import { createBoard } from "../src/board.ts";
import { createClaims } from "../src/claims.ts";
import { createEventBus, type SubagentEvent } from "../src/events.ts";

function watched() {
	const bus = createEventBus();
	const seen: SubagentEvent[] = [];
	bus.subscribe((event) => seen.push(event));
	return { bus, seen };
}

describe("an announced board", () => {
	test("every accepted post is on the bus, under the member that wrote it", () => {
		const { bus, seen } = watched();
		const board = announcedBoard(createBoard(), bus);

		const outcome = board.post("scout#1", { kind: "claim", text: "taking the parser" });

		assert.ok(outcome.ok);
		assert.deepEqual(seen, [{ type: "post", id: "scout#1", post: outcome.post }]);
	});

	test("a refused post is not announced: it said nothing to anybody", () => {
		const { bus, seen } = watched();
		const board = announcedBoard(createBoard({ limits: { maxPosts: 0 } }), bus);

		assert.equal(board.post("scout#1", { kind: "tell", text: "anything" }).ok, false);
		assert.deepEqual(seen, []);
	});

	test("being handed something is announced: the record answers who knew what", () => {
		const { bus, seen } = watched();
		const board = announcedBoard(createBoard(), bus);
		board.post("scout#2", { kind: "tell", text: "the parser is in src/pipeline.ts" });

		board.since("scout#1");

		assert.deepEqual(seen.at(-1), { type: "read", id: "scout#1", posts: ["p1"], waiting: 0 });
	});

	test("a read that was handed nothing is recorded too", () => {
		// The strongest thing the record holds about what a member could not have
		// known is that it looked and there was nothing there.
		const { bus, seen } = watched();
		announcedBoard(createBoard(), bus).since("scout#1");

		assert.deepEqual(seen, [{ type: "read", id: "scout#1", posts: [], waiting: 0 }]);
	});

	test("a read says how much was left behind, so a member falling behind shows", () => {
		const { bus, seen } = watched();
		const board = announcedBoard(createBoard(), bus);
		for (let n = 0; n < 30; n++) board.post("scout#2", { kind: "tell", text: `post ${n}` });

		board.since("scout#1", undefined, 25);

		const read = seen.at(-1) as { posts: readonly string[]; waiting: number };
		assert.equal(read.posts.length, 25);
		assert.equal(read.waiting, 5);
	});

	test("the record is the wrapped board's own: what was posted through it is all() of it", () => {
		const board = createBoard();
		const wrapped = announcedBoard(board, createEventBus());
		wrapped.post("scout#1", { kind: "tell", text: "x" });
		assert.equal(board.all().length, 1);
	});
});

describe("announced claims", () => {
	test("every grant and every refusal is recorded, with who holds it", () => {
		const { bus, seen } = watched();
		const claims = announcedClaims(createClaims({ keys: ["console.ts"] }), bus);

		claims.take("scout#1", "console.ts");
		claims.take("scout#2", "console.ts");

		assert.deepEqual(seen, [
			{ type: "claim", id: "scout#1", key: "console.ts", action: "take", ok: true },
			{ type: "claim", id: "scout#2", key: "console.ts", action: "take", ok: false, heldBy: "scout#1" },
		]);
	});

	test("a release says whether it was the holder's to give, and whose it was when not", () => {
		const { bus, seen } = watched();
		const claims = announcedClaims(createClaims(), bus);
		claims.take("scout#1", "a");

		claims.release("scout#2", "a");
		claims.release("scout#1", "a");

		assert.deepEqual(seen.slice(1), [
			{ type: "claim", id: "scout#2", key: "a", action: "release", ok: false, heldBy: "scout#1" },
			{ type: "claim", id: "scout#1", key: "a", action: "release", ok: true },
		]);
	});

	test("what a member that is gone was holding comes back one key at a time, on the bus", () => {
		const { bus, seen } = watched();
		const claims = announcedClaims(createClaims(), bus);
		claims.take("scout#1", "a");
		claims.take("scout#1", "b");

		assert.deepEqual(claims.releaseAll("scout#1"), ["a", "b"]);
		assert.deepEqual(seen.slice(2), [
			{ type: "claim", id: "scout#1", key: "a", action: "release", ok: true },
			{ type: "claim", id: "scout#1", key: "b", action: "release", ok: true },
		]);
		assert.deepEqual(claims.open(), []);
	});

	test("a member that held nothing announces nothing when it goes", () => {
		const { bus, seen } = watched();
		announcedClaims(createClaims(), bus).releaseAll("scout#1");
		assert.deepEqual(seen, []);
	});
});
