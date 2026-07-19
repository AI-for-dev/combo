import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SubagentEvent } from "../src/events.ts";
import {
	collapsedLine,
	createTuiCollector,
	detailLine,
	elapsedMs,
	formatToolCall,
	progressLine,
	statusIcon,
	summaryTable,
	widgetLines,
	widgetRows,
	type TuiCollector,
} from "../src/reporters/tui.ts";
import { emptyUsage, type Usage } from "../src/usage.ts";

const spawned = (id: string): SubagentEvent => ({
	type: "spawn",
	id,
	agent: id.split("#")[0] as string,
	lifetime: "task",
	openInHerdr: false,
});

const closed = (id: string, ok = true, usage: Partial<Usage> = {}): SubagentEvent => ({
	type: "close",
	id,
	result: {
		agent: id.split("#")[0] as string,
		output: "",
		messages: [],
		ok,
		error: ok ? undefined : "it broke",
		usage: { ...emptyUsage(), ...usage },
	},
});

/** Replays a sequence into a fresh collector. */
function replay(...events: SubagentEvent[]): TuiCollector {
	const collector = createTuiCollector();
	for (const event of events) collector.reporter(event);
	return collector;
}

describe("createTuiCollector", () => {
	test("builds one entry per subagent, in spawn order", () => {
		const collector = replay(spawned("scout#1"), spawned("coder#1"), spawned("scout#2"));

		assert.deepEqual(
			collector.snapshot().subagents.map((one) => one.id),
			["scout#1", "coder#1", "scout#2"],
			"a fan-out reads in launch order, not completion order",
		);
	});

	test("accumulates tool calls, text and usage", () => {
		const collector = replay(
			spawned("scout#1"),
			{ type: "tool", id: "scout#1", name: "grep", args: { pattern: "spawn" } },
			{ type: "tool", id: "scout#1", name: "read", args: { path: "/x/a.ts" } },
			{ type: "text", id: "scout#1", delta: "found " },
			{ type: "text", id: "scout#1", delta: "it" },
			{ type: "usage", id: "scout#1", usage: { ...emptyUsage(), turns: 1, input: 500 } },
		);

		const one = collector.snapshot().subagents[0]!;
		assert.deepEqual(
			one.tools.map((tool) => tool.name),
			["grep", "read"],
		);
		assert.equal(one.output, "found it", "deltas are joined, not replaced");
		assert.equal(one.usage.input, 500);
	});

	test("close records the outcome and the final usage", () => {
		const collector = replay(spawned("scout#1"), closed("scout#1", false, { turns: 2, input: 12_000 }));

		const one = collector.snapshot().subagents[0]!;
		assert.equal(one.status, "done");
		assert.equal(one.ok, false);
		assert.equal(one.error, "it broke");
		assert.equal(one.usage.input, 12_000, "a failed subagent still spent its tokens");
	});

	test("events for an unknown id are ignored", () => {
		const collector = replay({ type: "tool", id: "ghost#1", name: "grep", args: {} });
		assert.equal(collector.snapshot().total, 0);
	});

	test("setTask records what the core does not emit", () => {
		const collector = replay(spawned("scout#1"));
		collector.setTask("scout#1", "find the auth code");
		assert.equal(collector.snapshot().subagents[0]?.task, "find the auth code");

		// An unknown id is a no-op, not a crash.
		assert.doesNotThrow(() => collector.setTask("ghost#1", "x"));
	});

	test("onChange fires on every event, so the row knows to redraw", () => {
		const collector = createTuiCollector();
		let changes = 0;
		collector.onChange(() => changes++);

		collector.reporter(spawned("scout#1"));
		collector.reporter({ type: "tool", id: "scout#1", name: "grep", args: {} });
		collector.setTask("scout#1", "task");

		assert.equal(changes, 3);
	});

	test("counts running, done and failed independently", () => {
		const collector = replay(
			spawned("scout#1"),
			spawned("scout#2"),
			spawned("scout#3"),
			{ type: "status", id: "scout#1", status: "working" },
			closed("scout#2", true),
			closed("scout#3", false),
		);

		const snapshot = collector.snapshot();
		assert.equal(snapshot.total, 3);
		assert.equal(snapshot.running, 1);
		assert.equal(snapshot.done, 2);
		assert.equal(snapshot.failed, 1, "a failed subagent is done and failed");
	});

	test("aggregates usage across subagents without inventing wallMs", () => {
		const collector = replay(
			spawned("scout#1"),
			spawned("scout#2"),
			closed("scout#1", true, { turns: 1, busyMs: 900, input: 100 }),
			closed("scout#2", true, { turns: 1, busyMs: 800, input: 250 }),
		);

		const { usage } = collector.snapshot();
		assert.equal(usage.busyMs, 1_700);
		assert.equal(usage.input, 350);
		assert.equal(usage.turns, 2);
		assert.equal(usage.wallMs, 0, "elapsed time is not the collector's to know");
	});
});

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

describe("collapsedLine", () => {
	test("shows icon, id, task and the tool in flight", () => {
		const collector = replay(spawned("scout#1"), { type: "tool", id: "scout#1", name: "grep", args: {} });
		collector.setTask("scout#1", "find the auth code");

		const line = collapsedLine(collector.snapshot().subagents[0]!);
		assert.match(line, /^⏳ {2}scout#1/);
		assert.match(line, /find the auth code/);
		assert.match(line, /→ grep/);
	});

	test("a finished subagent shows no tool in flight", () => {
		const collector = replay(spawned("scout#1"), { type: "tool", id: "scout#1", name: "grep", args: {} }, closed("scout#1"));
		const line = collapsedLine(collector.snapshot().subagents[0]!);

		assert.match(line, /^✓/);
		assert.ok(!line.includes("→"), line);
	});

	test("a failed subagent shows ✗ and its error", () => {
		const collector = replay(spawned("scout#1"), closed("scout#1", false));
		const line = collapsedLine(collector.snapshot().subagents[0]!);

		assert.match(line, /^✗/);
		assert.match(line, /it broke/);
	});

	test("a long task is truncated to the given width", () => {
		const collector = replay(spawned("scout#1"));
		collector.setTask("scout#1", "a ".repeat(80));

		const line = collapsedLine(collector.snapshot().subagents[0]!, 20);
		assert.ok(line.length < 60, line);
	});
});

describe("the widget above the prompt", () => {
	const spawnedWith = (id: string, model?: string): SubagentEvent => ({
		type: "spawn",
		id,
		agent: id.split("#")[0] as string,
		lifetime: "task",
		openInHerdr: false,
		model,
	});

	test("two lines per subagent: a dot with what it does, then the quiet detail", () => {
		const collector = replay(
			spawnedWith("scout#1", "ilaas/qwen-3.6-35b-instruct"),
			{ type: "status", id: "scout#1", status: "working" },
			{ type: "tool", id: "scout#1", name: "grep", args: { pattern: "lifetime" } },
			{ type: "usage", id: "scout#1", usage: { ...emptyUsage(), input: 12_000, output: 209, busyMs: 12_400 } },
		);

		assert.deepEqual(widgetLines(collector.snapshot()), [
			"● scout#1  grep /lifetime/",
			"  ilaas/qwen-3.6-35b-instruct · ↑12k ↓209 · 12.4s",
		]);
	});

	test("the dot becomes a check when it finishes, a cross when it fails", () => {
		const ok = replay(spawned("scout#1"), closed("scout#1", true));
		assert.match(widgetLines(ok.snapshot())[0] as string, /^✓ scout#1 {2}done/);

		const bad = replay(spawned("scout#1"), closed("scout#1", false));
		assert.match(widgetLines(bad.snapshot())[0] as string, /^✗ scout#1 {2}it broke/);
	});

	test("the activity is the tool in flight, or a word when there is none yet", () => {
		const idle = replay(spawned("scout#1"));
		assert.match(widgetLines(idle.snapshot())[0] as string, /waiting/);

		const thinking = replay(spawned("scout#1"), { type: "status", id: "scout#1", status: "working" });
		assert.match(widgetLines(thinking.snapshot())[0] as string, /thinking/);
	});

	test("one pair of lines per subagent, in launch order", () => {
		const collector = replay(spawned("scout#1"), spawned("coder#1"));
		const lines = widgetLines(collector.snapshot());

		assert.equal(lines.length, 4);
		assert.match(lines[0] as string, /scout#1/);
		assert.match(lines[2] as string, /coder#1/);
	});

	test("no subagents means no widget at all", () => {
		assert.deepEqual(widgetLines(createTuiCollector().snapshot()), []);
	});

	test("the rows say what they are, so the caller applies colour and we can test layout", () => {
		const collector = replay(spawned("scout#1"), closed("scout#1", false));
		const rows = widgetRows(collector.snapshot());

		assert.equal(rows[0]?.kind, "activity");
		assert.equal((rows[0] as { status: string }).status, "failed", "colour is chosen from this, not parsed back out");
		assert.equal(rows[1]?.kind, "detail");
	});

	test("a missing model is simply left out, never guessed", () => {
		const collector = replay(spawned("scout#1"));
		const detail = widgetLines(collector.snapshot())[1] as string;

		assert.ok(!detail.includes("undefined"), detail);
		assert.match(detail, /↑0 ↓0/);
	});

	test("the clock counts up while it works, instead of sitting at 0.0s", () => {
		// busyMs only lands when the turn ends, so a widget that read it alone
		// would show 0.0s for the whole wait and then jump to the total.
		const collector = replay(spawned("scout#1"), { type: "status", id: "scout#1", status: "working" });
		const one = collector.snapshot().subagents[0]!;

		const start = one.startedAt as number;
		assert.equal(typeof start, "number", "a working subagent has a clock");
		assert.equal(Math.round(elapsedMs(one, start + 3_000) / 1000), 3);
		assert.match(detailLine(one, start + 12_400), /12\.4s/);
	});

	test("the clock stops once the turn ends, showing the measured time", () => {
		const collector = replay(spawned("scout#1"), closed("scout#1", true, { busyMs: 9_200 }));
		const one = collector.snapshot().subagents[0]!;

		assert.equal(one.startedAt, undefined, "a finished subagent has no running clock");
		assert.equal(elapsedMs(one, 1e12), 9_200, "the answer no longer depends on now");
	});

	test("cost appears only when the provider reported one", () => {
		const free = replay(spawned("scout#1"), closed("scout#1", true, { input: 10 }));
		assert.ok(!(widgetLines(free.snapshot())[1] as string).includes("$"));

		const paid = replay(spawned("scout#1"), closed("scout#1", true, { input: 10, cost: 0.0412 }));
		assert.match(widgetLines(paid.snapshot())[1] as string, /\$0\.0412/);
	});
});

describe("statusIcon", () => {
	test("failure wins over doneness", () => {
		const collector = replay(spawned("scout#1"), closed("scout#1", false));
		assert.equal(statusIcon(collector.snapshot().subagents[0]!), "✗");
	});
});

describe("progressLine", () => {
	test("reads n/m while things run", () => {
		const collector = replay(
			spawned("scout#1"),
			spawned("scout#2"),
			spawned("scout#3"),
			closed("scout#1"),
			closed("scout#2"),
			{ type: "status", id: "scout#3", status: "working" },
		);

		assert.equal(progressLine(collector.snapshot()), "2/3 done, 1 running");
	});

	test("mentions failures only when there are some", () => {
		const clean = replay(spawned("scout#1"), closed("scout#1"));
		assert.equal(progressLine(clean.snapshot()), "1/1 done");

		const broken = replay(spawned("scout#1"), closed("scout#1", false));
		assert.match(progressLine(broken.snapshot()), /1 failed/);
	});
});

describe("summaryTable", () => {
	test("one line per subagent, a total, and the parallelism when there is any", () => {
		const collector = replay(
			spawned("scout#1"),
			spawned("scout#2"),
			closed("scout#1", true, { turns: 1, busyMs: 900 }),
			closed("scout#2", true, { turns: 1, busyMs: 800 }),
		);

		const lines = summaryTable(collector.snapshot(), 1_000);
		assert.equal(lines.length, 4, "two subagents, a total, a parallelism line");
		assert.match(lines[0] as string, /^✓ scout#1/);
		assert.match(lines[2] as string, /^total/);
		assert.match(lines[3] as string, /parallelism ×1\.70/);
	});

	test("no parallelism line when the work was sequential", () => {
		const collector = replay(spawned("scout#1"), closed("scout#1", true, { busyMs: 500 }));
		const lines = summaryTable(collector.snapshot(), 1_000);

		assert.equal(lines.length, 2);
		assert.ok(!lines.some((line) => line.includes("parallelism")), lines.join("\n"));
	});
});
