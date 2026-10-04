import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SubagentEvent } from "../src/events.ts";
import { createRunPicture, snapshotFrom } from "../src/reporters/picture.ts";
import { treeOrder } from "../src/reporters/tree.ts";
import { emptyUsage } from "../src/usage.ts";
import { blank, closed, replay, spawned, working } from "./fixtures/picture.ts";

describe("createRunPicture", () => {
	test("builds one entry per subagent, in spawn order", () => {
		const picture = replay(spawned("scout#1"), spawned("coder#1"), spawned("scout#2"));

		assert.deepEqual(
			picture.snapshot().subagents.map((one) => one.id),
			["scout#1", "coder#1", "scout#2"],
			"a fan-out reads in launch order, not completion order",
		);
	});

	test("launch order wins over the order the spawns arrived in", () => {
		// Sessions come up in whatever order they come up in, and `spawn` waits
		// for one because it carries the model. Measured in a real pi: three
		// scouts launched together arrived 2, 1, 3.
		const late = (id: string, order: number): SubagentEvent => ({
			type: "spawn",
			id,
			agent: id.split("#")[0] as string,
			order,
			lifetime: "task",
			openInHerdr: false,
		});
		const picture = replay(late("scout#2", 2), late("scout#1", 1), late("scout#3", 3));

		assert.deepEqual(
			picture.snapshot().subagents.map((one) => one.id),
			["scout#1", "scout#2", "scout#3"],
		);
	});

	test("accumulates tool calls, text and usage", () => {
		const picture = replay(
			spawned("scout#1"),
			{ type: "tool", id: "scout#1", name: "grep", args: { pattern: "spawn" } },
			{ type: "tool", id: "scout#1", name: "read", args: { path: "/x/a.ts" } },
			{ type: "text", id: "scout#1", delta: "found " },
			{ type: "text", id: "scout#1", delta: "it" },
			{ type: "usage", id: "scout#1", usage: { ...emptyUsage(), turns: 1, input: 500 } },
		);

		const one = picture.snapshot().subagents[0]!;
		assert.deepEqual(
			one.tools.map((tool) => tool.name),
			["grep", "read"],
		);
		assert.equal(one.output, "found it", "deltas are joined, not replaced");
		assert.equal(one.usage.input, 500);
	});

	test("close records the outcome and the final usage", () => {
		const picture = replay(spawned("scout#1"), closed("scout#1", false, { turns: 2, input: 12_000 }));

		const one = picture.snapshot().subagents[0]!;
		assert.equal(one.status, "done");
		assert.equal(one.ok, false);
		assert.equal(one.error, "it broke");
		assert.equal(one.usage.input, 12_000, "a failed subagent still spent its tokens");
	});

	test("events for an unknown id are ignored", () => {
		const picture = replay({ type: "tool", id: "ghost#1", name: "grep", args: {} });
		assert.equal(picture.snapshot().total, 0);
	});

	test("onChange fires on every event, so the row knows to redraw", () => {
		const picture = createRunPicture();
		let changes = 0;
		picture.onChange(() => changes++);

		picture.reporter(spawned("scout#1"));
		picture.reporter({ type: "tool", id: "scout#1", name: "grep", args: {} });
		picture.reporter(working("scout#1", "task"));

		assert.equal(changes, 3);
	});

	test("counts running, done and failed independently", () => {
		const picture = replay(
			spawned("scout#1"),
			spawned("scout#2"),
			spawned("scout#3"),
			{ type: "status", id: "scout#1", status: "working" },
			closed("scout#2", true),
			closed("scout#3", false),
		);

		const snapshot = picture.snapshot();
		assert.equal(snapshot.total, 3);
		assert.equal(snapshot.running, 1);
		assert.equal(snapshot.done, 2);
		assert.equal(snapshot.failed, 1, "a failed subagent is done and failed");
	});

	test("aggregates usage across subagents without inventing wallMs", () => {
		const picture = replay(
			spawned("scout#1"),
			spawned("scout#2"),
			closed("scout#1", true, { turns: 1, busyMs: 900, input: 100 }),
			closed("scout#2", true, { turns: 1, busyMs: 800, input: 250 }),
		);

		const { usage } = picture.snapshot();
		assert.equal(usage.busyMs, 1_700);
		assert.equal(usage.input, 350);
		assert.equal(usage.turns, 2);
		assert.equal(usage.wallMs, 0, "elapsed time is not the picture's to know");
	});

	test("of() reads one subagent, and knows nothing of one it never saw spawn", () => {
		const picture = replay(spawned("scout#1"), working("scout#1", "find the auth code"));

		assert.equal(picture.of("scout#1")?.task, "find the auth code");
		assert.equal(picture.of("ghost#1"), undefined);
	});

	test("a delegated subagent knows how deep it sits, from the spawn that placed it", () => {
		const picture = replay(spawned("explorer#1"), spawned("splitter#1", "explorer#1"), spawned("scout#1", "splitter#1"));

		assert.deepEqual(
			picture.snapshot().subagents.map((one) => one.depth),
			[0, 1, 2],
		);
	});

	test("a parent nobody saw spawn leaves its child a root", () => {
		// A reporter attached mid-run: the parent's spawn happened before it was
		// listening, and the child is placed rather than lost.
		assert.equal(replay(spawned("scout#1", "explorer#9")).of("scout#1")?.depth, 0);
	});
});

describe("snapshotFrom", () => {
	test("derives the same counts and total the live picture does", () => {
		const picture = replay(
			spawned("scout#1"),
			spawned("scout#2"),
			working("scout#1", "x"),
			closed("scout#2", false, { input: 40, cost: 0.5 }),
		);

		const live = picture.snapshot();
		const rebuilt = snapshotFrom(live.subagents);

		assert.deepEqual(rebuilt, live);
		assert.equal(rebuilt.running, 1);
		assert.equal(rebuilt.failed, 1);
		assert.equal(rebuilt.usage.cost, 0.5);
	});

	test("keeps the order it was given, and does not share the list", () => {
		const subagents = [blank("b#1"), blank("a#1")];
		const snapshot = snapshotFrom(subagents);

		assert.deepEqual(
			snapshot.subagents.map((one) => one.id),
			["b#1", "a#1"],
		);
		assert.notEqual(snapshot.subagents, subagents);
	});
});

describe("treeOrder", () => {
	test("a child follows the parent it hangs under, however the spawns interleaved", () => {
		const picture = replay(
			spawned("explorer#1"),
			spawned("explorer#2"),
			spawned("scout#1", "explorer#1"),
			spawned("scout#2", "explorer#2"),
			spawned("scout#3", "explorer#1"),
		);

		assert.deepEqual(
			treeOrder(picture.snapshot().subagents).map((one) => [one.id, one.depth]),
			[
				["explorer#1", 0],
				["scout#1", 1],
				["scout#3", 1],
				["explorer#2", 0],
				["scout#2", 1],
			],
		);
	});

	test("a grandchild hangs under the child, not under the root", () => {
		const picture = replay(spawned("explorer#1"), spawned("splitter#1", "explorer#1"), spawned("scout#1", "splitter#1"));

		assert.deepEqual(
			treeOrder(picture.snapshot().subagents).map((one) => one.depth),
			[0, 1, 2],
		);
	});

	test("a parent nobody saw spawn leaves its child a root rather than losing it", () => {
		// A reporter attached mid-run: the parent's spawn happened before it
		// was listening, and a measurement that silently drops a subagent is
		// worse than one that misplaces it.
		const picture = replay(spawned("scout#1", "explorer#9"));

		assert.deepEqual(
			treeOrder(picture.snapshot().subagents).map((one) => [one.id, one.depth]),
			[["scout#1", 0]],
		);
	});

	test("two subagents pointing at each other are still both reported", () => {
		const a = { ...blank("a#1"), parentId: "b#1" };
		const b = { ...blank("b#1"), parentId: "a#1" };

		assert.deepEqual(
			treeOrder([a, b]).map((one) => one.id),
			["a#1", "b#1"],
		);
	});
});
