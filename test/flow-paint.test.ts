/**
 * A flow run painted for the terminal: the plan as it fills, what each
 * subagent of a running visit is doing under it, and a plan taller than the
 * widget cut from the top.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { paintFlow } from "../extension/ui/flow.ts";
import type { SubagentEvent } from "../src/events.ts";
import { livePlan } from "../src/flow/index.ts";
import { createRunPicture } from "../src/reporters/picture.ts";
import { emptyUsage } from "../src/usage.ts";
import { checked } from "./fixtures/flow.ts";
import { spawned, working } from "./fixtures/picture.ts";

const plain = { fg: (_colour: string, text: string) => text };
const flow = checked("  - id: look\n    agent: scout\n    reads: [input]\n  - id: answer\n    agent: synthesiser\n    reads: [look]", { look: "Look.", answer: "Answer." });
const four = checked("  - id: look\n    agent: scout\n  - id: answer\n    agent: synthesiser\n  - id: again\n    agent: scout\n  - id: last\n    agent: scout", { look: "Look.", answer: "Answer.", again: "Again.", last: "Last." });

/** `events` through a picture and into the plan of `flow`, painted `width` wide. */
function painted(events: SubagentEvent[], width: number, maxRows?: number, of = flow): string[] {
	const picture = createRunPicture();
	for (const event of events) picture.reporter(event);
	return paintFlow(livePlan(of, [], events), plain, width, { snapshot: picture.snapshot(), selected: "scout#1", maxRows });
}

const looking: SubagentEvent[] = [
	{ type: "visit_start", path: "look", node: "look", kind: "agent" },
	{ ...spawned("scout#1"), visit: "look" },
	working("scout#1", "Look."),
	{ type: "tool", id: "scout#1", name: "grep", args: { pattern: "journal" } },
];

describe("paintFlow", () => {
	test("a running visit has its subagent under it, with what it is doing, selected", () => {
		const lines = painted(looking, 100);
		assert.equal(lines[0], "● f · 0 visits · 0s · ↑0 ↓0");
		assert.equal(lines[1], "● look");
		assert.match(lines[2] ?? "", /^ {2}▸ scout#1 {2}grep \/journal\/ {2}↑0 ↓0 · \d+\.\ds$/);
		assert.match(lines[3] ?? "", /^○ answer · agent synthesiser/);
	});

	test("no line is wider than the terminal", () => {
		for (const line of painted(looking, 30)) assert.ok(line.length <= 30, line);
	});

	test("past its rows, what runs now stays in view, and each cut says how many lines it holds", () => {
		const below = painted(looking, 100, 2);
		assert.deepEqual(below.slice(1), ["● look", "… 2 lines below"]);

		const answering: SubagentEvent[] = [
			...looking,
			{ type: "visit_end", path: "look", node: "look", kind: "agent", ok: true, output: "found", agent: "scout", wallMs: 5, usage: emptyUsage() },
			{ type: "visit_start", path: "answer", node: "answer", kind: "agent" },
			{ ...spawned("synthesiser#1"), visit: "answer" },
			working("synthesiser#1", "Answer."),
		];
		const both = painted(answering, 100, 4, four);
		assert.equal(both.length, 5);
		assert.equal(both[1], "… 1 line above");
		assert.equal(both[2], "● answer");
		assert.match(both[3] ?? "", /^ {2}● synthesiser#1 {2}thinking…/);
		assert.equal(both[4], "… 2 lines below");
	});
});
