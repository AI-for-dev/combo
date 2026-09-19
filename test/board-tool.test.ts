/**
 * The `board` tool: what a member can do with it, and what it is told when it
 * cannot.
 *
 * The board itself is tested next door. What is tested here is the seam - the
 * id in the closure, the paging, the refusals a model reads - and the one
 * property everything else rests on: a member cannot post as another.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBoard, type Post } from "../src/board.ts";
import { boardTool, declaresBoard, BOARD_TOOL } from "../src/board-tool.ts";
import { createEventBus, type SubagentEvent } from "../src/events.ts";
import { callTool } from "./fixtures/call-tool.ts";

/** What the model is shown, whether it went well or not. */
async function answer(tool: ReturnType<typeof boardTool>, params: unknown): Promise<string> {
	const result = await callTool(tool, params);
	return result.content[0]?.text ?? "";
}

/** Whether the call came back as a refusal. */
async function refused(tool: ReturnType<typeof boardTool>, params: unknown): Promise<boolean> {
	return (await callTool(tool, params)).isError === true;
}

describe("declaresBoard", () => {
	test("only a definition that names the tool gets it", () => {
		assert.equal(declaresBoard(["read", BOARD_TOOL]), true);
		assert.equal(declaresBoard(["read", "grep"]), false);
		assert.equal(declaresBoard(undefined), false);
	});
});

describe("posting", () => {
	test("the member posting is the one the tool was built for", async () => {
		const board = createBoard();
		const tool = boardTool({ board, from: "scout#1" });

		// `from` is not in the schema; a model sending one anyway must not be
		// believed, which is the property the whole board rests on.
		await callTool(tool, { action: "post", kind: "tell", text: "found it", from: "auditor#1" });

		assert.equal(board.all()[0]?.from, "scout#1");
	});

	test("a post answers with the id it got, so the member can refer to it", async () => {
		const board = createBoard();
		const tool = boardTool({ board, from: "scout#1" });

		assert.equal(await answer(tool, { action: "post", kind: "tell", text: "found it" }), "Posted as p1.");
	});

	test("a kind the board does not know is refused, with the list", async () => {
		const board = createBoard();
		const tool = boardTool({ board, from: "scout#1" });

		const said = await answer(tool, { action: "post", kind: "shout", text: "hello" });
		assert.match(said, /ask, tell, result, claim, release, hold/);
		assert.match(said, /"shout"/);
		assert.ok(await refused(tool, { action: "post", kind: "shout", text: "hello" }));
		assert.equal(board.all().length, 0);
	});

	test("a post with nothing in it is refused before the board sees it", async () => {
		const board = createBoard();
		const tool = boardTool({ board, from: "scout#1" });

		assert.match(await answer(tool, { action: "post", kind: "tell", text: "   " }), /says something/);
		assert.equal(board.all().length, 0);
	});

	test("the board's own refusal is passed on word for word", async () => {
		const board = createBoard({ limits: { maxPosts: 1 } });
		const tool = boardTool({ board, from: "scout#1" });
		await callTool(tool, { action: "post", kind: "tell", text: "first" });

		assert.match(await answer(tool, { action: "post", kind: "tell", text: "second" }), /full at 1 posts/);
	});

	test("an action that is neither says so", async () => {
		const tool = boardTool({ board: createBoard(), from: "scout#1" });

		assert.match(await answer(tool, { action: "shout" }), /"post" or "read"/);
		assert.ok(await refused(tool, { action: "shout" }));
	});
});

describe("reading", () => {
	test("a member catches up once, and then there is nothing new", async () => {
		const board = createBoard();
		board.post("scout#2", { kind: "tell", text: "the parser is in src/pipeline.ts" });
		const tool = boardTool({ board, from: "scout#1" });

		assert.match(await answer(tool, { action: "read" }), /p1 scout#2 \[tell\] the parser/);
		assert.equal(await answer(tool, { action: "read" }), "Nothing new on the board.");
	});

	test("each member keeps its own place", async () => {
		const board = createBoard();
		board.post("scout#3", { kind: "tell", text: "one" });
		const first = boardTool({ board, from: "scout#1" });
		const second = boardTool({ board, from: "scout#2" });

		await callTool(first, { action: "read" });
		assert.match(await answer(second, { action: "read" }), /one/, "the second reader has read nothing yet");
	});

	test("a long board arrives a page at a time, and says how much is left", async () => {
		const board = createBoard();
		for (let n = 0; n < 30; n++) board.post("scout#2", { kind: "tell", text: `post ${n}` });
		const tool = boardTool({ board, from: "scout#1" });

		const page = await answer(tool, { action: "read" });
		assert.equal(page.split("\n").filter((line) => line.startsWith("p")).length, 25);
		assert.match(page, /\(5 more waiting - read again\.\)/);

		const rest = await answer(tool, { action: "read" });
		assert.equal(rest.split("\n").length, 5, "and the cursor moved past what was given, not past the board");
	});
});

describe("the record", () => {
	test("every post is announced, so the run can be read back", async () => {
		const bus = createEventBus();
		const seen: SubagentEvent[] = [];
		bus.subscribe((event) => seen.push(event));
		const tool = boardTool({ board: createBoard(), from: "scout#1", bus });

		await callTool(tool, { action: "post", kind: "claim", text: "taking the parser" });

		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.type, "post");
		assert.equal((seen[0] as { id: string }).id, "scout#1");
		assert.equal((seen[0] as { post: Post }).post.text, "taking the parser");
	});

	test("being handed something is announced too: the record answers who knew what", async () => {
		const board = createBoard();
		board.post("scout#2", { kind: "tell", text: "the parser is in src/pipeline.ts" });
		const bus = createEventBus();
		const seen: SubagentEvent[] = [];
		bus.subscribe((event) => seen.push(event));
		const tool = boardTool({ board, from: "scout#1", bus });

		await callTool(tool, { action: "read" });

		assert.deepEqual(seen, [{ type: "read", id: "scout#1", posts: ["p1"], waiting: 0 }]);
	});

	test("a read that was handed nothing is recorded, and says so", async () => {
		// The strongest thing the record holds about what a member could not have
		// known is that it looked and there was nothing there.
		const bus = createEventBus();
		const seen: SubagentEvent[] = [];
		bus.subscribe((event) => seen.push(event));
		const tool = boardTool({ board: createBoard(), from: "scout#1", bus });

		await callTool(tool, { action: "read" });

		assert.deepEqual(seen, [{ type: "read", id: "scout#1", posts: [], waiting: 0 }]);
	});

	test("a read says how much was left behind, so a member falling behind shows", async () => {
		const board = createBoard();
		for (let n = 0; n < 30; n++) board.post("scout#2", { kind: "tell", text: `post ${n}` });
		const bus = createEventBus();
		const seen: SubagentEvent[] = [];
		bus.subscribe((event) => seen.push(event));
		const tool = boardTool({ board, from: "scout#1", bus });

		await callTool(tool, { action: "read" });

		const read = seen[0] as { posts: readonly string[]; waiting: number };
		assert.equal(read.posts.length, 25);
		assert.equal(read.waiting, 5);
	});

	test("a refused post is not announced", async () => {
		const bus = createEventBus();
		const seen: SubagentEvent[] = [];
		bus.subscribe((event) => seen.push(event));
		const tool = boardTool({ board: createBoard({ limits: { maxPosts: 0 } }), from: "scout#1", bus });

		await callTool(tool, { action: "post", kind: "tell", text: "anything" });
		assert.deepEqual(seen, []);
	});
});
