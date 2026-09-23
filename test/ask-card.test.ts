/**
 * The question card as a flow's `ask` puts it, driven key by key.
 *
 * `ctx.ui.custom` is replaced by a double that builds the real component and
 * hands it keystrokes, so what is under test is what a person meets: what the
 * card draws, which entries it offers, what `enter` and `esc` give, and that a
 * card whose question no longer stands comes down.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AskUi } from "../extension/pi.ts";
import { createAskUi, items, OTHER, SUBMIT } from "../extension/ui/ask.ts";
import { isAsking } from "../extension/ui/asking.ts";
import type { Asking, Question } from "../src/ask.ts";
import { testTheme } from "./fixtures/theme.ts";

initTheme();

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

const question: Question = {
	header: "plan",
	question: "Build this?",
	options: [{ label: "Build it" }, { label: "Change the plan", description: "back to the planner" }],
};

type Card = { lines(width?: number): string[]; press(...keys: string[]): void; closed: boolean };

/** A `ctx.ui` whose cards are built for real and wait for keys. `cards` holds each one shown, in order. */
function keyedUi() {
	const cards: Card[] = [];
	let shown: () => void = () => {};
	const ui: AskUi = {
		theme: testTheme(),
		custom<T>(factory: (tui: unknown, theme: never, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T> {
			return new Promise((resolve) => {
				const card: Card = {
					closed: false,
					lines: (width = 80) => component.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b_[^\x07]*\x07/g, "").trimEnd()),
					press: (...keys) => keys.forEach((key) => component.handleInput(key)),
				};
				const component = factory({ requestRender: () => {} }, testTheme() as never, {}, (value) => {
					card.closed = true;
					resolve(value);
				}) as { render(width: number): string[]; handleInput(data: string): void };
				cards.push(card);
				shown();
			});
		},
		input: async () => assert.fail("a flow's card types in its own box, not in pi's"),
	};
	/** The card at `index`, once it is on screen. */
	const card = async (index: number): Promise<Card> => {
		while (cards[index] === undefined) await new Promise<void>((resolve) => (shown = resolve));
		return cards[index];
	};
	return { ui, card };
}

/** Asks `asking` of `question` and returns the answer promise with the first card. */
async function ask(asking: Asking, of: Question = question) {
	const { ui, card } = keyedUi();
	const answer = createAskUi(ui)(of, asking);
	return { answer, first: await card(0), card };
}

describe("a flow's question card", () => {
	test("a closed card offers its labels and its enough, and no typed answer", () => {
		assert.deepEqual(
			items(question, { form: "closed", enough: "Stop here" }).map((item) => [item.value, item.label]),
			[["Build it", "Build it"], ["Change the plan", "Change the plan"], [SUBMIT, "Stop here"]],
		);
	});

	test("an open card with no enough offers the typed answer and no way to submit", () => {
		assert.deepEqual(items(question, { form: "open", enough: false }).map((item) => item.value), ["Build it", "Change the plan", OTHER]);
	});

	test("the card shows the visit, each read under its name, and what esc does", async () => {
		const context = [{ name: "brief", body: "Add a cache." }, { name: "plan.output", body: '{\n  "steps": 2\n}' }, { name: "notes", body: "" }];
		const { first, answer } = await ask({ form: "closed", context, visit: "review/1/go", enough: false });
		const lines = first.lines();
		first.press(ESC);
		await answer;
		const at = (text: string) => lines.findIndex((line) => line.includes(text));

		assert.match(lines[at("[plan]")] ?? "", /\[plan\]\s+review\/1\/go/);
		assert.ok(at("brief") < at("Add a cache.") && at("Add a cache.") < at("plan.output"));
		assert.ok(lines.includes('     "steps": 2'), "a typed value keeps its JSON indentation under its name");
		assert.equal(lines[at("notes") + 1]?.trim(), "(empty)");
		assert.ok(at("(empty)") < at("Build this?"), "the reads come above the question");
		assert.ok(!lines.some((line) => line.includes("Other…")));
		assert.equal(lines[at("esc")]?.trim(), "↑↓ choose • enter answer • esc stop the run");
	});

	test("the help line names the enough it offers, in the file's words", async () => {
		const { first, answer } = await ask({ form: "closed", enough: "Stop here" });
		const lines = first.lines();
		first.press(ESC);
		await answer;
		assert.ok(lines.some((line) => line.trim() === "↑↓ choose • enter answer • esc Stop here"));
		assert.ok(lines.some((line) => line.includes("Stop here") && !line.includes("esc")));
	});

	test("picking an option answers it; esc declines it", async () => {
		const picked = await ask({ form: "closed", enough: false });
		picked.first.press(DOWN, ENTER);
		assert.deepEqual(await picked.answer, { question: "Build this?", answer: "Change the plan", custom: false });

		const declined = await ask({ form: "closed", enough: "Stop here" });
		declined.first.press(ESC);
		assert.equal(await declined.answer, undefined);
	});

	test("a yes or no answers yes or no, whatever the options", async () => {
		const { first, answer } = await ask({ form: "confirm", enough: false }, { question: "Commit these changes?", options: [] });
		assert.deepEqual(first.lines().filter((line) => /Yes|No/.test(line)).map((line) => line.trim()), ["→ Yes", "No"]);
		first.press(DOWN, ENTER);
		assert.deepEqual(await answer, { question: "Commit these changes?", answer: "no", custom: false });
	});

	test("a free text answers what was typed, an empty one included", async () => {
		const typed = await ask({ form: "text", enough: false }, { question: "Anything else?", options: [] });
		assert.ok(typed.first.lines().some((line) => line.trim() === "enter answer • esc stop the run"));
		typed.first.press(..."  keep it short ", ENTER);
		assert.deepEqual(await typed.answer, { question: "Anything else?", answer: "keep it short", custom: true });

		const empty = await ask({ form: "text", enough: false }, { question: "Anything else?", options: [] });
		empty.first.press(ENTER);
		assert.equal((await empty.answer)?.answer, "");
	});

	test("Other… types in the card, and esc there goes back to the options rather than stopping the run", async () => {
		const { first, answer, card } = await ask({ form: "open", context: [{ name: "brief", body: "Add a cache." }], enough: false });
		first.press(DOWN, DOWN, ENTER);
		const box = await card(1);
		assert.ok(box.lines().includes("   Add a cache."), "the text box keeps the reads above the question");
		assert.ok(box.lines().some((line) => line.trim() === "enter answer • esc back to the options"));
		box.press(ESC);

		const again = await card(2);
		again.press(DOWN, DOWN, ENTER);
		(await card(3)).press(..."use redis", ENTER);
		assert.deepEqual(await answer, { question: "Build this?", answer: "use redis", custom: true });
	});

	test("an aborted signal takes the card down, and escape is given back", async () => {
		const controller = new AbortController();
		const { first, answer } = await ask({ form: "closed", enough: false, signal: controller.signal });
		assert.equal(isAsking(), true);
		controller.abort();
		assert.equal(await answer, undefined);
		assert.equal(first.closed, true);
		assert.equal(isAsking(), false);
	});

	test("a signal aborted before the card shows shows nothing", async () => {
		const { ui } = keyedUi();
		const answer = await createAskUi({ ...ui, custom: () => assert.fail("no card for a question that no longer stands") })(question, { signal: AbortSignal.abort() });
		assert.equal(answer, undefined);
	});

	test("nothing it draws is wider than the terminal, and a key is never cut from what it does", async () => {
		const context = [{ name: "diff", body: `diff --git a/src/cache.ts b/src/cache.ts\n+${"export const ttl = 60;".repeat(4)}` }];
		const { first, answer } = await ask({ form: "open", context, visit: "build/round/2/go", enough: "Stop here" });
		const drawn = [24, 40, 80].map((width) => ({ width, lines: first.lines(width) }));
		first.press(ESC);
		await answer;
		for (const { width, lines } of drawn) {
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} fits ${width} columns`);
		}
		assert.deepEqual(drawn[0]?.lines.slice(-5, -2).map((line) => line.trim()), ["↑↓ choose", "enter answer", "esc Stop here"]);
	});
});
