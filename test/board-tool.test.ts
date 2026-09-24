/**
 * The `board` tool: what a member can do with it, and what it is told when it
 * cannot.
 *
 * The board itself is tested next door, and so is what it announces. What is
 * tested here is the seam - the id in the closure, the paging, the refusals a
 * model reads - and the one property everything else rests on: a member cannot
 * post as another.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBoard } from "../src/board/board.ts";
import { createClaims } from "../src/board/claims.ts";
import { boardTool, declaresBoard, BOARD_TOOL } from "../src/board/tool.ts";
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

	test("a post answers another by its id, and what answers a member is the first thing its read shows", async () => {
		const board = createBoard();
		const mine = boardTool({ board, from: "debater#1" });
		const theirs = boardTool({ board, from: "debater#2" });
		await callTool(mine, { action: "post", kind: "result", text: "VOTE: Rust" });
		board.post("debater#3", { kind: "tell", text: "thinking aloud" });

		assert.equal(await answer(theirs, { action: "post", kind: "tell", text: "not for a new team", re: " p1 " }), "Posted as p3.");
		assert.match(await answer(mine, { action: "read" }), /^Answering you:\np3 debater#2 re p1 \(debater#1\) \[tell\] not for a new team\n\nThe rest:\np2 /);
		assert.match(await answer(theirs, { action: "post", kind: "tell", text: "and again", re: "p9" }), /there is no post p9/);
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

describe("taking and releasing", () => {
	const setup = (keys?: readonly string[]) => {
		const claims = createClaims(keys ? { keys } : {});
		const board = createBoard();
		return { claims, first: boardTool({ board, from: "scout#1", claims }), second: boardTool({ board, from: "scout#2", claims }) };
	};

	test("the first to ask holds it, and the second is told who does and what is left", async () => {
		const { first, second } = setup(["console.ts", "tui.ts", "record.ts"]);

		assert.match(await answer(first, { action: "take", key: "console.ts" }), /console\.ts is yours/);

		const denied = await answer(second, { action: "take", key: "console.ts" });
		assert.match(denied, /held by scout#1 - ask scout#1/);
		assert.match(denied, /Still free: tui\.ts, record\.ts/, "one call is enough to move on");
	});

	test("what a model invents is refused with what there is", async () => {
		// The three members of a real run named one file three ways. A key that
		// is not on the list has to come back as a list, not as a grant.
		const { first } = setup(["console.ts", "tui.ts"]);

		const stray = await answer(first, { action: "take", key: "I will handle src/reporters/console.ts" });
		assert.match(stray, /nothing called.*to claim - there is console\.ts, tui\.ts/);
	});

	test("only the holder gives it back, and then somebody else can have it", async () => {
		const { first, second } = setup();
		await callTool(first, { action: "take", key: "the parser" });

		assert.match(await answer(second, { action: "release", key: "the parser" }), /not holding `the parser` - scout#1 is/);
		assert.match(await answer(second, { action: "release", key: "nothing at all" }), /not holding `nothing at all`\./, "and a thing nobody holds names nobody");
		assert.match(await answer(first, { action: "release", key: "the parser" }), /Gave up the parser/);
		assert.match(await answer(second, { action: "take", key: "the parser" }), /is yours/);
	});

	test("a tool with nothing to claim does not offer to", async () => {
		const tool = boardTool({ board: createBoard(), from: "scout#1" });

		assert.ok(!tool.description.includes("take"), "and the description does not mention it");
		assert.match(await answer(tool, { action: "take", key: "anything" }), /nothing to take here/);
	});

	test("taking without saying what is refused", async () => {
		const { first } = setup();
		assert.match(await answer(first, { action: "take" }), /Name what you are taking/);
	});

});
