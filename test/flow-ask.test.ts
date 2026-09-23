/**
 * The `ask` node as a file says it: its three forms and their outputs, what
 * the flow stage refuses, what a condition may compare, what the run stage
 * refuses with nobody there, and its scripted answers in a dry run.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkRun, dryRunFlow, showType, type CheckedAskNode, type CheckedFlow } from "../src/flow/index.ts";
import { checked, refused } from "./fixtures/flow.ts";

/** A flow of one ask, `pick`, written with `keys`. */
const ASK = (keys: string) => checked(`  - id: pick\n${keys.replace(/^/gm, "    ")}`, {});

/** The checked `ask` at the root of `flow`, by id. */
function askIn(flow: CheckedFlow, id: string): CheckedAskNode {
	const node = flow.nodes.find((one) => one.id === id);
	assert.equal(node?.kind, "ask");
	return node as CheckedAskNode;
}

/** An agent writing a `Question`, and an `ask-from` putting it, then `after`. */
const FROM = (after = "", keys = "") =>
	`  - id: write\n    agent: planner\n    output: { q: Question }\n  - id: put\n    ask-from: write.output.q${keys}${after}`;

describe("an ask, read", () => {
	test("is a choice card, a yes or no, or a free text, by what is written, each with its output", () => {
		const card = askIn(ASK('ask: "Ship it?"\noptions: [Yes, { label: Later, description: after the review }]'), "pick");
		const confirm = askIn(ASK('ask: "Commit?"\nconfirm: true'), "pick");
		const text = askIn(ASK('ask: "Anything else?"'), "pick");
		assert.deepEqual([card.form, card.options], ["choice", [{ label: "Yes" }, { label: "Later", description: "after the review" }]]);
		assert.deepEqual([card, confirm, text].map((one) => showType(one.output)), ["{ answered: boolean, answer?: Yes | Later, custom?: boolean }", "{ yes: boolean }", "string"]);
		const from = askIn(checked(FROM(), { write: "Write." }), "put");
		assert.deepEqual([from.form, from.question, showType(from.output)], ["choice", { from: "write.output.q" }, "{ answered: boolean, answer?: string, custom?: boolean }"]);
	});

	test("refuses keys its form does not take together", () => {
		assert.deepEqual(refused('  - id: a\n    ask: "?"\n    options: [x, y]\n    confirm: true'), ["ask-form-conflict a.confirm"]);
		assert.deepEqual(refused('  - id: a\n    ask: "?"\n    confirm: true\n    enough: "Stop"\n  - id: b\n    ask: "?"\n    enough: "Stop"'), ["ask-form-conflict a.enough", "ask-form-conflict b.enough"]);
		assert.deepEqual(refused(`${FROM("", "\n    options: [x, y]\n    confirm: true")}`, "## write\nWrite."), ["ask-form-conflict put.options", "ask-form-conflict put.confirm"]);
		assert.deepEqual(refused('  - id: a\n    ask: "?"\n    confirm: false'), ["key-type a.confirm"]);
	});

	test("offers two to four literal options, none twice", () => {
		const options = (list: string) => refused(`  - id: a\n    ask: "?"\n    options: ${list}`);
		assert.deepEqual(options("[x]"), ["ask-options-count a.options"]);
		assert.deepEqual(options("[a, b, c, d, e]"), ["ask-options-count a.options"]);
		assert.deepEqual(options("[x, { label: x, description: again }]"), ["ask-options-duplicate a.options"]);
		assert.deepEqual(options("[x, { name: y }]"), ["unknown-key a.options[1].name", "key-type a.options[1].label"]);
	});

	test("holds `default:` to its own form, a label of its options, and refuses `retry:`", () => {
		const off = (keys: string) => refused(`  - id: a\n    ask: "?"\n${keys.replace(/^/gm, "    ")}`);
		assert.deepEqual(off("options: [Yes, No]\ndefault: Maybe"), ["ask-default-mismatch a.default"]);
		assert.deepEqual(off("confirm: true\ndefault: yes"), ["ask-default-mismatch a.default"]);
		assert.deepEqual(off("default: false"), ["ask-default-mismatch a.default"]);
		assert.deepEqual(off("retry: 1"), ["retry-refused a.retry"]);
		assert.deepEqual(askIn(ASK('ask: "?"\nconfirm: true\ndefault: false\ntimeout: 1m'), "pick").default, false);
	});

	test("reads a `Question` with `ask-from:`, and its `reads:` are typed like an agent's", () => {
		const other = "  - id: write\n    agent: planner\n    output: { q: string }\n  - id: put\n    ask-from: write.output.q";
		assert.deepEqual(refused(other, "## write\nWrite."), ["key-type put.ask-from"]);
		assert.deepEqual(refused('  - id: a\n    ask: "?"\n    reads: [nowhere]'), ["unknown-address a.reads"]);
		assert.deepEqual(refused('  - id: a\n    ask: "?"', "## a\nAsk."), ["section-not-agent a"]);
	});
});

describe("a condition reading an ask", () => {
	const gate = (when: string) => `\n  - id: gate\n    choice:\n      - when: ${when}\n        do:\n          - id: more\n            ask: "More?"\n    default: []`;

	test("holds a literal card's answer to its labels", () => {
		const card = `  - id: pick\n    ask: "Ship it?"\n    options: [Yes, No]\n    enough: Enough`;
		assert.ok(checked(card + gate('pick.output.answered && pick.output.answer == "Yes"'), {}));
		assert.deepEqual(refused(card + gate('pick.output.answer == "yes"')), ["condition-enum-value gate.choice[0].when"]);
	});

	test("compares an `ask-from` answer to no literal, and reads `answered` and `custom`", () => {
		assert.ok(checked(FROM(gate("put.output.answered && !put.output.custom")), { write: "Write." }));
		for (const when of ['put.output.answer == "Yes"', 'put.output.answer in ["Yes", "No"]', 'put.output.answer > "m"']) {
			assert.deepEqual(refused(FROM(gate(when)), "## write\nWrite."), ["condition-free-string gate.choice[0].when"], when);
		}
	});
});

describe("the run stage, with nobody there", () => {
	const NODES = `  - id: gate
    choice:
      - when: input == "never"
        do:
          - id: first
            ask: "First?"
    default:
      - id: second
        ask: "Second?"
        confirm: true
  - id: fine
    ask: "Fine?"
    confirm: true
    default: true
  - id: enough
    ask: "Enough?"
    options: [a, b]
    enough: "Stop asking"`;

	test("refuses every question nobody answering leaves without a value, behind a `choice` too", async () => {
		const flow = checked(NODES, {});
		const faults = async (somebodyThere: boolean) => {
			const result = await checkRun(flow, { cwd: process.cwd(), ports: {}, somebodyThere });
			return !result.ok && result.faults.map(({ code, at }) => `${code} ${at}`);
		};
		assert.deepEqual(await faults(false), ["unattended-ask gate/first.ask", "unattended-ask gate/second.ask"]);
		assert.deepEqual(await faults(true), ["unattended-ask gate/first.ask", "unattended-ask gate/second.ask"], "no `ask` port is nobody there");
		const there = await checkRun(flow, { cwd: process.cwd(), ports: { ask: async () => undefined }, somebodyThere: true });
		assert.ok(there.ok);
	});

	test("holds an ask reading `diff` to the `git` port, as it holds an agent", async () => {
		const result = await checkRun(ASK('ask: "Commit this?"\nconfirm: true\ndefault: false\nreads: [diff]'), { cwd: process.cwd(), ports: {}, somebodyThere: false });
		assert.deepEqual(!result.ok && result.faults.map(({ code, at }) => `${code} ${at}`), ["git-port-missing pick.reads"]);
	});
});

describe("an ask in a dry run", () => {
	const FLOW = checked(
		`  - id: pick
    ask: "Ship it?"
    options: [Yes, No]
  - id: sure
    ask: "Sure?"
    confirm: true
    default: true
    timeout: 1m
  - id: note
    ask: "A note?"`,
		{},
	);

	test("is answered with an output of its form", async () => {
		const run = await dryRunFlow(FLOW, "x", { pick: { answered: true, answer: "Yes", custom: false }, sure: { yes: false }, note: "" });
		assert.ok("journal" in run, JSON.stringify(run));
		assert.deepEqual(run.journal.map((entry) => entry.output), [{ answered: true, answer: "Yes", custom: false }, { yes: false }, ""]);
	});

	test("takes the node's own path when nobody answers, and stops the run on a declined card", async () => {
		const missed = await dryRunFlow(FLOW, "x", { pick: { answered: true, answer: "No" }, sure: { fail: "timeout" }, note: { fail: "nobody" } });
		assert.ok("journal" in missed);
		assert.deepEqual(missed.journal.map((entry) => entry.output ?? entry.error?.kind), [{ answered: true, answer: "No" }, { yes: true }, "nobody"]);
		const stopped = await dryRunFlow(FLOW, "x", { pick: { fail: "stopped" }, sure: { yes: true }, note: "" });
		assert.deepEqual(!stopped.ok && "error" in stopped && [stopped.error.kind, stopped.path, stopped.journal.length], ["stopped", "pick", 1]);
	});

	test("refuses an answer off its form, and a kind its keys rule out", async () => {
		const run = await dryRunFlow(FLOW, "x", { pick: [{ answered: true, answer: "Maybe" }, { answered: false }, { answered: true }], note: [{ fail: "timeout" }, { yes: true }], sure: { fail: "stopped" } });
		assert.deepEqual(!run.ok && "faults" in run && run.faults.map(({ code, at }) => `${code} ${at}`), [
			"answer-off-schema pick[0]",
			"answer-off-schema pick[1]",
			"answer-off-schema pick[2]",
			"answer-past-max pick",
			"answer-fail-kind note[0]",
			"answer-off-schema note[1]",
			"answer-past-max note",
		]);
		const sure = await dryRunFlow(checked('  - id: sure\n    ask: "Sure?"\n    options: [a, b]\n    enough: "Stop"', {}), "x", { sure: { fail: "stopped" } });
		assert.deepEqual(!sure.ok && "faults" in sure && sure.faults.map(({ code }) => code), ["answer-fail-kind"]);
	});
});
