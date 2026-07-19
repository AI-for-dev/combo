/**
 * The question card, without a terminal.
 *
 * `ctx.ui.custom` is replaced by a double that picks a value straight away, so
 * what is under test is the wiring the user actually feels: which entries appear
 * on the card, what "Other…" does, and what counts as a submit.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createAskUi, items, OTHER, SUBMIT, type AskUi } from "../extension/ask-ui.ts";
import type { Question } from "../src/ask.ts";
import { testTheme } from "./fixtures/theme.ts";

initTheme();

const question: Question = {
	header: "storage",
	question: "Which storage?",
	options: [
		{ label: "sqlite", description: "a file, no server" },
		{ label: "postgres", description: "a server, more of everything" },
	],
};

/** A `ctx.ui` that answers the card with `pick`, and free text with `typed`. */
function fakeUi(pick: string | undefined, typed?: string) {
	const asked: string[] = [];
	const ui: AskUi = {
		theme: testTheme(),
		async custom<T>(factory: (tui: unknown, theme: never, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T> {
			// Build the component for real: a card that throws while rendering is
			// the failure that hides, since pi would silently fall back.
			let resolved: T | undefined;
			const component = factory({ requestRender: () => {} }, testTheme() as never, {}, (value) => {
				resolved = value;
			}) as { render(width: number): string[] };
			assert.doesNotThrow(() => component.render(80));
			return (resolved ?? pick) as T;
		},
		async input(title: string) {
			asked.push(title);
			return typed;
		},
	};
	return { ui, asked };
}

describe("the question card", () => {
	test("shows the agent's options, then Other and the submit", () => {
		const entries = items(question);
		assert.deepEqual(
			entries.map((item) => item.label),
			["sqlite", "postgres", "Other…", "That's enough - build it"],
		);
		assert.equal(entries[0]?.description, "a file, no server");
	});

	test("the sentinels cannot collide with an answer a model wrote", () => {
		// An agent proposing the option "Other…" must not silently become the
		// free-text box, so the sentinels live outside the printable space.
		for (const sentinel of [OTHER, SUBMIT]) {
			assert.ok(sentinel.startsWith("\u0000"));
			assert.ok(!items(question).some((item) => item.label === sentinel));
		}
	});

	test("picking an option answers the question", async () => {
		const { ui } = fakeUi("sqlite");
		const answer = await createAskUi(ui)(question);

		assert.deepEqual(answer, { question: "Which storage?", answer: "sqlite", custom: false });
	});

	test("Other… opens a free-text box and marks the answer as the user's own", async () => {
		const { ui, asked } = fakeUi(OTHER, "  duckdb  ");
		const answer = await createAskUi(ui)(question);

		assert.deepEqual(asked, ["Which storage?"], "the box repeats the question, so it is answerable on its own");
		assert.deepEqual(answer, { question: "Which storage?", answer: "duckdb", custom: true });
	});

	test("the submit entry ends the interview", async () => {
		const { ui } = fakeUi(SUBMIT);
		assert.equal(await createAskUi(ui)(question), undefined);
	});

	test("escaping the card means the same as submitting - answers are not thrown away", async () => {
		const { ui } = fakeUi(undefined);
		assert.equal(await createAskUi(ui)(question), undefined);
	});

	test("declining the free-text box submits rather than asking again", async () => {
		for (const typed of [undefined, "", "   "]) {
			const { ui } = fakeUi(OTHER, typed);
			assert.equal(await createAskUi(ui)(question), undefined);
		}
	});

	test("a card with no header still builds", async () => {
		const { ui } = fakeUi("a");
		const answer = await createAskUi(ui)({ question: "Which one?", options: [{ label: "a" }] });
		assert.equal(answer?.answer, "a");
	});
});
