import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRunPicture } from "../src/reporters/picture.ts";
import {
	callLine,
	currentActivity,
	detailLine,
	elapsedMs,
	formatToolCall,
	progressLine,
	standingOf,
	statusColour,
	statusIcon,
	summaryTable,
	widgetLines,
	widgetRows,
} from "../src/reporters/tui.ts";
import { emptyUsage } from "../src/usage.ts";
import { closed, replay, spawned, working } from "./fixtures/picture.ts";

describe("formatToolCall", () => {
	test("renders built-in tools the way pi does", () => {
		assert.equal(formatToolCall("bash", { command: "npm test" }), "$ npm test");
		assert.equal(formatToolCall("read", { path: "/x/a.ts" }), "read /x/a.ts");
		assert.equal(formatToolCall("read", { path: "/x/a.ts", offset: 1, limit: 10 }), "read /x/a.ts:1-11");
		assert.equal(formatToolCall("grep", { pattern: "spawn", path: "/x" }), "grep /spawn/ in /x");
		assert.equal(formatToolCall("grep", { pattern: "spawn" }), "grep /spawn/");
		assert.equal(formatToolCall("ls", { path: "/x" }), "ls /x");
		assert.equal(formatToolCall("edit", { path: "/x/a.ts" }), "edit /x/a.ts");
	});

	test("shortens the home directory, like every pi path display", () => {
		const home = process.env.HOME;
		if (!home) return;
		assert.equal(formatToolCall("read", { path: `${home}/notes.md` }), "read ~/notes.md");
	});

	test("keeps only the first line of a multi-line command", () => {
		assert.equal(formatToolCall("bash", { command: "cd /x\nnpm test" }), "$ cd /x");
	});

	test("an unknown tool degrades to key=value, never to raw JSON", () => {
		const line = formatToolCall("mystery", { alpha: "one", beta: 2 });
		assert.equal(line, "mystery alpha=one beta=2");
	});

	test("an unknown tool with no arguments is just its name", () => {
		assert.equal(formatToolCall("mystery", {}), "mystery");
		assert.equal(formatToolCall("mystery", undefined), "mystery");
	});

	test("long argument values are truncated", () => {
		const line = formatToolCall("mystery", { text: "x".repeat(100) });
		assert.ok(line.length < 60, line);
		assert.match(line, /…/);
	});
});

describe("the widget above the prompt", () => {

	test("two lines per subagent: a dot with what it does, then the quiet detail", () => {
		const picture = replay(
			spawned("scout#1", undefined, "ilaas/qwen-3.6-35b-instruct"),
			{ type: "status", id: "scout#1", status: "working" },
			{ type: "tool", id: "scout#1", name: "grep", args: { pattern: "lifetime" } },
			{ type: "usage", id: "scout#1", usage: { ...emptyUsage(), turns: 1, input: 12_000, output: 209, busyMs: 12_400 } },
		);

		assert.deepEqual(widgetLines(picture.snapshot()), [
			"● scout#1  grep /lifetime/",
			"  ilaas/qwen-3.6-35b-instruct · ↑12k ↓209 · 12.4s",
		]);
	});

	test("the dot becomes a check when it finishes, a cross when it fails", () => {
		const ok = replay(spawned("scout#1"), closed("scout#1", true, { turns: 1 }));
		// No "done" beside the tick: the tick is what says so.
		assert.match(widgetLines(ok.snapshot())[0] as string, /^✓ scout#1 {2}↑0 ↓0/);

		const bad = replay(spawned("scout#1"), closed("scout#1", false, { turns: 1 }));
		assert.match(widgetLines(bad.snapshot())[0] as string, /^✗ scout#1 {2}it broke {2}↑0 ↓0/);
	});

	test("a subagent that is over takes one line, and its numbers move up beside the tick", () => {
		const picture = replay(
			spawned("scout#1", undefined, "ilaas/qwen-3.6-35b-instruct"),
			closed("scout#1", true, { turns: 1, input: 12_000, output: 209, busyMs: 12_400 }),
		);

		assert.deepEqual(widgetLines(picture.snapshot()), ["✓ scout#1  ilaas/qwen-3.6-35b-instruct · ↑12k ↓209 · 12.4s"]);
	});

	test("a call that came back an error is marked so, with pi's words, and never reads as one that ran", () => {
		const picture = replay(
			spawned("scout#1"),
			{ type: "status", id: "scout#1", status: "working" },
			{ type: "tool", id: "scout#1", name: "write", args: { path: "notes.txt" }, call: "c1" },
			{ type: "tool", id: "scout#1", name: "read", args: { path: "a.ts" }, call: "c2" },
			{ type: "tool_error", id: "scout#1", name: "write", error: "Tool write not found", call: "c1" },
		);
		const [write, read] = picture.snapshot().subagents[0]?.tools ?? [];
		assert.equal(callLine(write!), "✗ write notes.txt · Tool write not found");
		assert.equal(callLine(read!), "read a.ts");

		const last = replay(spawned("scout#1"), { type: "tool", id: "scout#1", name: "write", args: { path: "notes.txt" } }, { type: "tool_error", id: "scout#1", name: "write", error: "Tool write not found" });
		assert.equal(currentActivity(last.snapshot().subagents[0]!), "✗ write notes.txt · Tool write not found");
	});

	test("the activity is the tool in flight, or a word when there is none yet", () => {
		const idle = replay(spawned("scout#1"));
		assert.match(widgetLines(idle.snapshot())[0] as string, /waiting/);

		const thinking = replay(spawned("scout#1"), { type: "status", id: "scout#1", status: "working" });
		assert.match(widgetLines(thinking.snapshot())[0] as string, /thinking/);
	});

	test("one pair of lines per subagent, in launch order", () => {
		const picture = replay(spawned("scout#1"), spawned("coder#1"));
		const lines = widgetLines(picture.snapshot());

		assert.equal(lines.length, 4);
		assert.match(lines[0] as string, /scout#1/);
		assert.match(lines[2] as string, /coder#1/);
	});

	test("no subagents means no widget at all", () => {
		assert.deepEqual(widgetLines(createRunPicture().snapshot()), []);
	});

	test("the rows say what they are, so the caller applies colour and we can test layout", () => {
		const failed = widgetRows(replay(spawned("scout#1"), closed("scout#1", false, { turns: 1 })).snapshot());
		assert.equal(failed.length, 1, "a subagent that is over is one row");
		assert.equal(failed[0]?.kind, "activity");
		assert.equal((failed[0] as { status: string }).status, "failed", "colour is chosen from this, not parsed back out");
		assert.match((failed[0] as { detail?: string }).detail ?? "", /↑0 ↓0/);

		const working = widgetRows(replay(spawned("scout#1"), { type: "status", id: "scout#1", status: "working" }).snapshot());
		assert.equal(working[1]?.kind, "detail", "while it works the numbers stay on their own line");
		assert.equal((working[0] as { detail?: string }).detail, undefined);
	});

	test("a missing model is simply left out, never guessed", () => {
		const picture = replay(spawned("scout#1"));
		const detail = widgetLines(picture.snapshot())[1] as string;

		assert.ok(!detail.includes("undefined"), detail);
		assert.equal(detail, "  0.0s");
	});

	test("no token figure until a turn has ended, since pi reads its counters then", () => {
		const first = replay(spawned("scout#1", undefined, "ilaas/gemma-4-31b"), { type: "status", id: "scout#1", status: "working" });
		assert.match(widgetLines(first.snapshot())[1] as string, /^ {2}ilaas\/gemma-4-31b · \d+\.\ds$/);

		// A provider that reports nothing reads zero once a turn has ended: that zero was read.
		const after = replay(spawned("scout#1", undefined, "ilaas/gemma-4-31b"), { type: "usage", id: "scout#1", usage: { ...emptyUsage(), turns: 1 } });
		assert.match(widgetLines(after.snapshot())[1] as string, /· ↑0 ↓0 ·/);
	});

	test("the clock counts up while it works, instead of sitting at 0.0s", () => {
		// busyMs only lands when the turn ends, so a widget that read it alone
		// would show 0.0s for the whole wait and then jump to the total.
		const picture = replay(spawned("scout#1"), { type: "status", id: "scout#1", status: "working" });
		const one = picture.snapshot().subagents[0]!;

		const start = one.startedAt as number;
		assert.equal(typeof start, "number", "a working subagent has a clock");
		assert.equal(Math.round(elapsedMs(one, start + 3_000) / 1000), 3);
		assert.match(detailLine(one, start + 12_400), /12\.4s/);
	});

	test("the clock stops once the turn ends, showing the measured time", () => {
		const picture = replay(spawned("scout#1"), closed("scout#1", true, { busyMs: 9_200 }));
		const one = picture.snapshot().subagents[0]!;

		assert.equal(one.startedAt, undefined, "a finished subagent has no running clock");
		assert.equal(elapsedMs(one, 1e12), 9_200, "the answer no longer depends on now");
	});

	test("cost appears only when the provider reported one", () => {
		const free = replay(spawned("scout#1"), closed("scout#1", true, { turns: 1, input: 10 }));
		assert.ok(!(widgetLines(free.snapshot())[0] as string).includes("$"));

		const paid = replay(spawned("scout#1"), closed("scout#1", true, { input: 10, cost: 0.0412 }));
		assert.match(widgetLines(paid.snapshot())[0] as string, /\$0\.0412/);
	});
});

describe("how a subagent stands", () => {
	test("failure wins over doneness", () => {
		const picture = replay(spawned("scout#1"), closed("scout#1", false));
		assert.equal(standingOf(picture.snapshot().subagents[0]!), "failed");
	});

	test("one glyph and one colour per standing, decided once for every reader", () => {
		assert.deepEqual(
			(["working", "idle", "blocked", "done", "failed"] as const).map((standing) => [standing, statusIcon(standing), statusColour(standing)]),
			[
				["working", "●", "accent"],
				["idle", "●", "accent"],
				["blocked", "●", "warning"],
				["done", "✓", "success"],
				["failed", "✗", "error"],
			],
		);
	});
});

describe("progressLine", () => {
	test("reads n/m while things run", () => {
		const picture = replay(
			spawned("scout#1"),
			spawned("scout#2"),
			spawned("scout#3"),
			closed("scout#1"),
			closed("scout#2"),
			{ type: "status", id: "scout#3", status: "working" },
		);

		assert.equal(progressLine(picture.snapshot()), "2/3 done, 1 running");
	});

	test("mentions failures only when there are some", () => {
		const clean = replay(spawned("scout#1"), closed("scout#1"));
		assert.equal(progressLine(clean.snapshot()), "1/1 done");

		const broken = replay(spawned("scout#1"), closed("scout#1", false));
		assert.match(progressLine(broken.snapshot()), /1 failed/);
	});
});

describe("the widget and the tree", () => {
	test("a row says how deep it sits, and the plain lines indent it", () => {
		const picture = replay(spawned("explorer#1"), spawned("scout#1", "explorer#1"));

		assert.deepEqual(
			widgetRows(picture.snapshot())
				.filter((row) => row.kind === "activity")
				.map((row) => [row.id, row.depth]),
			[
				["explorer#1", 0],
				["scout#1", 1],
			],
		);

		const lines = widgetLines(picture.snapshot());
		assert.match(lines[0] as string, /^● explorer#1/);
		assert.match(lines[2] as string, /^ {2}● scout#1/);
	});
});

describe("summaryTable", () => {
	test("a delegated subagent is indented under the one that asked for it", () => {
		const picture = replay(
			spawned("explorer#1"),
			spawned("scout#1", "explorer#1"),
			closed("explorer#1", true, { turns: 1, busyMs: 100 }),
			closed("scout#1", true, { turns: 1, busyMs: 400 }),
		);

		const lines = summaryTable(picture.snapshot(), 500);

		assert.match(lines[0] as string, /^✓ explorer#1/);
		assert.match(lines[1] as string, /^✓ {3}scout#1/, "the child is indented under it");
		assert.match(lines[2] as string, /^total/);
		// The tree costs what the tree costs: the parent's own turn and its
		// child's, never one of the two.
		assert.match(lines[2] as string, /2 turns 0\.5s/);
	});

	test("one line per subagent, a total, and the parallelism when there is any", () => {
		const picture = replay(
			spawned("scout#1"),
			spawned("scout#2"),
			closed("scout#1", true, { turns: 1, busyMs: 900 }),
			closed("scout#2", true, { turns: 1, busyMs: 800 }),
		);

		const lines = summaryTable(picture.snapshot(), 1_000);
		assert.equal(lines.length, 4, "two subagents, a total, a parallelism line");
		assert.match(lines[0] as string, /^✓ scout#1/);
		assert.match(lines[2] as string, /^total/);
		assert.match(lines[3] as string, /parallelism ×1\.70/);
	});

	test("no parallelism line when the work was sequential", () => {
		const picture = replay(spawned("scout#1"), closed("scout#1", true, { busyMs: 500 }));
		const lines = summaryTable(picture.snapshot(), 1_000);

		assert.equal(lines.length, 2);
		assert.ok(!lines.some((line) => line.includes("parallelism")), lines.join("\n"));
	});
});
