/**
 * The `ask` node run: the card the port is handed, what each answer gives,
 * "enough" and the stop, nobody there, a `timeout:` on elapsed time, and
 * questions asked at once queueing one card at a time.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Answer, Asking, AskUser, Question } from "../src/ask.ts";
import { runFlow, type CheckedFlow, type FlowResult, type RunFlowOptions } from "../src/flow/index.ts";
import { checked, flowSpawn, launched } from "./fixtures/flow.ts";
import { waitFor } from "./fixtures/wait-for.ts";

/** A person at the port: `reply` answers the n-th card, and every card is kept as it was put. */
function person(reply: (question: Question, asking: Asking, n: number) => Answer | undefined | Promise<Answer | undefined>) {
	const cards: { question: Question; asking: Asking }[] = [];
	const ask: AskUser = async (question, asking = {}) => {
		cards.push({ question, asking });
		return reply(question, asking, cards.length - 1);
	};
	return { ask, cards };
}

/** What a person picking or typing `answer` gives back. */
const says = (answer: string, custom = false): Answer => ({ question: "", answer, custom });

/** `flow` run with `ask` at the port and somebody there. */
async function asked(flow: CheckedFlow, ask: AskUser, options: RunFlowOptions = {}): Promise<FlowResult> {
	return runFlow(await launched(flow, { ports: { ask }, somebodyThere: true }), "add a cache", options);
}

/** Each visit's output or error kind, as it ends, by path. */
function ends() {
	const ended: Record<string, unknown> = {};
	const onEvent: RunFlowOptions["onEvent"] = (event) => {
		if (event.type === "visit_end") ended[event.path] = event.ok ? event.output : event.error?.kind;
	};
	return { ended, onEvent };
}

/** A card that stays up until it is taken down, and then answers nothing. */
const untilTakenDown = (_question: Question, asking: Asking) => new Promise<undefined>((resolve) => asking.signal?.addEventListener("abort", () => resolve(undefined)));

describe("an ask, run", () => {
	test("puts the question as written, its reads above it, its visit, and says whether \"enough\" is offered", async () => {
		const flow = checked(
			`  - id: plan
    agent: planner
    output: { steps: [string] }
  - id: go
    ask: "Build this?"
    options: [Yes, No]
    enough: "That's enough"
    reads: [input, plan]`,
			{ plan: "Plan." },
		);
		const them = person(() => says("Yes"));
		const result = await asked(flow, them.ask, { spawn: flowSpawn([[{ text: "", submit: { steps: ["one"] } }]]).spawn });
		assert.deepEqual(result.ok && result.output, { answered: true, answer: "Yes", custom: false });
		const [card] = them.cards;
		assert.deepEqual(card?.question, { question: "Build this?", options: [{ label: "Yes" }, { label: "No" }] });
		const { signal: _, ...asking } = card?.asking ?? {};
		assert.deepEqual(asking, { form: "closed", visit: "go", enough: "That's enough", context: [{ name: "input", body: "add a cache" }, { name: "plan", body: '{\n  "steps": [\n    "one"\n  ]\n}' }] });
	});

	test("gives a yes or no, a free text, and a pick or a typed answer on a `Question` an agent wrote", async () => {
		const flow = checked(
			`  - id: write
    agent: planner
    output: { q: Question }
  - id: put
    ask-from: write.output.q
  - id: sure
    ask: "Sure?"
    confirm: true
  - id: note
    ask: "A note?"`,
			{ write: "Write." },
		);
		const question = { header: "Store", question: "Where?", options: [{ label: "Redis" }, { label: "Memory" }] };
		const them = person((_q, _a, n) => [says("SQLite", true), says("no"), says("")][n]);
		const { ended, onEvent } = ends();
		const result = await asked(flow, them.ask, { spawn: flowSpawn([[{ text: "", submit: { q: question } }]]).spawn, onEvent });
		assert.ok(result.ok);
		assert.deepEqual(them.cards.map((card) => [card.question, card.asking.form, card.asking.enough]), [
			[question, "open", false],
			[{ question: "Sure?", options: [] }, "confirm", false],
			[{ question: "A note?", options: [] }, "text", false],
		]);
		assert.deepEqual([ended.put, ended.sure, ended.note], [{ answered: true, answer: "SQLite", custom: true }, { yes: false }, ""]);
	});

	test("gives `answered: false` on \"enough\", and stops the whole run where none is offered", async () => {
		const enough = await asked(checked('  - id: go\n    ask: "Go?"\n    options: [a, b]\n    enough: "Enough"', {}), person(() => undefined).ask);
		assert.deepEqual(enough.ok && enough.output, { answered: false });
		const flow = checked('  - id: go\n    ask: "Go?"\n    on-fail: continue\n  - id: after\n    agent: scout', { after: "After." });
		const fake = flowSpawn([[{ text: "never" }]]);
		const stopped = await asked(flow, person(() => undefined).ask, { spawn: fake.spawn });
		assert.deepEqual(!stopped.ok && [stopped.error.kind, stopped.path], ["stopped", "go"]);
		assert.equal(fake.created.length, 0, "`on-fail: continue` does not catch the stop key");
	});

	test("with nobody there, takes `default:`, else `answered: false` where \"enough\" is offered", async () => {
		const flow = checked(
			`  - id: sure
    ask: "Sure?"
    confirm: true
    default: false
  - id: pick
    ask: "Which?"
    options: [a, b]
    default: b
  - id: go
    ask: "Go?"
    options: [a, b]
    enough: "Enough"`,
			{},
		);
		const { ended, onEvent } = ends();
		const result = await runFlow(await launched(flow), "x", { onEvent });
		assert.ok(result.ok);
		assert.deepEqual(ended, { sure: { yes: false }, pick: { answered: true, answer: "b", custom: false }, go: { answered: false } });
	});

	test("bounded by its own `timeout:` from when its card is shown, then takes its `default:`, or fails `timeout`", async () => {
		const flow = checked('  - id: sure\n    ask: "Sure?"\n    confirm: true\n    default: true\n    timeout: 1s\n  - id: note\n    ask: "A note?"\n    timeout: 1s', {});
		const them = person(untilTakenDown);
		const started = performance.now();
		const result = await asked(flow, them.ask);
		const elapsed = performance.now() - started;
		assert.deepEqual(!result.ok && [result.error, result.path], [{ kind: "timeout", message: "no answer within 1000 ms, and the question has no `default:`" }, "note"]);
		assert.ok(elapsed >= 2_000 && elapsed < 4_000, `${elapsed} ms`);
		assert.ok(them.cards.every((card) => card.asking.signal?.aborted), "each card is taken down");
	});
});

describe("asks at once", () => {
	test("queue one card at a time in arrival order, each naming its visit, and only the asking branch waits", async () => {
		const flow = checked(
			`  - id: both
    parallel:
      left:
        - id: first
          ask: "First?"
      right:
        - id: second
          ask: "Second?"
      busy:
        - id: work
          agent: scout`,
			{ work: "Work." },
		);
		const answers: ((answer: Answer) => void)[] = [];
		const them = person(() => new Promise((resolve) => answers.push(resolve)));
		const { ended, onEvent } = ends();
		const running = asked(flow, them.ask, { spawn: flowSpawn([[{ text: "worked" }]]).spawn, onEvent });
		await waitFor(() => them.cards.length === 1 && "both/busy/work" in ended);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(them.cards.map((card) => card.asking.visit), ["both/left/first"], "the second card waits for the first, the busy branch for neither");
		answers[0]?.(says("one"));
		await waitFor(() => them.cards.length === 2);
		answers[1]?.(says("two"));
		const result = await running;
		assert.deepEqual(them.cards.map((card) => card.asking.visit), ["both/left/first", "both/right/second"]);
		assert.deepEqual(result.ok && result.output, {
			left: { ok: true, output: "one" },
			right: { ok: true, output: "two" },
			busy: { ok: true, output: "worked" },
		});
	});
});
