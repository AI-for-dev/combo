/**
 * A flow run painted for the terminal: the plan as it fills, what each
 * subagent of a running visit is doing under it, and a plan taller than the
 * widget cut from the top.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { paintFlow, planWidget } from "../extension/ui/flow.ts";
import type { SubagentEvent } from "../src/events.ts";
import { livePlan } from "../src/flow/index.ts";
import { createRunPicture } from "../src/reporters/picture.ts";
import { emptyUsage } from "../src/usage.ts";
import { checked } from "./fixtures/flow.ts";
import { spawned, working } from "./fixtures/picture.ts";

const plain = { fg: (_colour: string, text: string) => text };
/** Colours as a terminal gets them: codes around the text, which a column count ignores and `trimEnd` cannot see past. */
const coloured = { fg: (_colour: string, text: string) => `\x1b[36m${text}\x1b[39m` };
const flow = checked("  - id: look\n    agent: scout\n    reads: [input]\n  - id: answer\n    agent: synthesiser\n    reads: [look]", { look: "Look.", answer: "Answer." });
const four = checked("  - id: look\n    agent: scout\n  - id: answer\n    agent: synthesiser\n  - id: again\n    agent: scout\n  - id: last\n    agent: scout", { look: "Look.", answer: "Answer.", again: "Again.", last: "Last." });

/** `events` through a picture and into the plan of `flow`, painted `width` wide. */
function painted(events: SubagentEvent[], width: number, maxRows?: number, of = flow, theme = plain): string[] {
	const picture = createRunPicture();
	for (const event of events) picture.reporter(event);
	return paintFlow(livePlan(of, [], events), theme, width, { snapshot: picture.snapshot(), selected: "scout#1", maxRows });
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
		assert.equal(lines[0], "● f · 0 visits · 0s");
		assert.equal(lines[1], "● look");
		assert.match(lines[2] ?? "", /^ {2}▸ scout#1 {2}grep \/journal\/ {2}\d+\.\ds$/);
		assert.match(lines[3] ?? "", /^○ answer · agent synthesiser/);
	});

	test("no line is wider than the terminal", () => {
		for (const line of painted(looking, 30)) assert.ok(line.length <= 30, line);
	});

	test("no line is wider than it is given, however deep the visit and however long what its subagents do", () => {
		const nested = checked(
			"  - id: deliver\n    loop: audit.output.approved\n    max: 2\n    do:\n      - id: work\n        map: [a]\n        do:\n          - id: pair\n            loop: review.output.approved\n            max: 2\n            do:\n              - id: review\n                agent: reviewer\n                output: { approved: boolean }\n      - id: audit\n        agent: reviewer\n        output: { approved: boolean }",
			{ review: "Review.", audit: "Audit." },
		);
		const long = "the `add` function subtracts instead of adding, and its test asserts the wrong sum 字".repeat(3);
		const events: SubagentEvent[] = [
			...["deliver", "deliver#1/work", "deliver#1/work[1]/pair", "deliver#1/work[1]/pair#1/review"].map((path): SubagentEvent => ({ type: "visit_start", path, node: path.replace(/#\d+|\[\d+\]/g, ""), kind: "loop" })),
			{ ...spawned("reviewer#1"), visit: "deliver#1/work[1]/pair#1/review" },
			working("reviewer#1", "Review."),
			{ type: "tool", id: "reviewer#1", name: "verdict", args: { approved: false, raised: [long], remarks: long } },
			spawned("scout#9", "reviewer#1"),
			working("scout#9", "Look."),
			{ type: "tool", id: "scout#9", name: "bash", args: { command: `grep -rn\t'${long}' .` } },
		];
		for (const width of [20, 40, 60, 80, 100, 118, 119, 120, 121, 160]) {
			for (const line of painted(events, width, undefined, nested, coloured)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			const picture = createRunPicture();
			for (const event of events) picture.reporter(event);
			const widget = planWidget(livePlan(nested, [], events, 1_000), coloured, { snapshot: picture.snapshot() }, () => [])(undefined, coloured as never);
			for (const line of widget.render(width)) assert.ok(visibleWidth(line) <= width, `widget ${width}: ${line}`);
		}
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
