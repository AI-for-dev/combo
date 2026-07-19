/**
 * The question card: one question, its options, and two ways out.
 *
 * This is the pi implementation of the {@link AskUser} port. It owns the
 * terminal for the length of one question and gives it straight back - which is
 * why the interview can be driven from a slash command but never from a tool the
 * model calls: nobody can answer a question that is being asked inside a turn.
 *
 * Two entries are appended to every card, exactly as Claude Code does:
 * **Other…** for a free answer, and **that's enough** to submit. The second one
 * is not a cancel - the answers already given still count, and the brief is
 * still written. `esc` means the same thing, so the reflex to escape out of a
 * dialog does not throw the conversation away.
 */

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { Answer, AskUser, Question } from "../src/index.ts";

/**
 * Sentinels for the two entries we add ourselves.
 *
 * A NUL prefix, not a plain string: the other values are labels a model wrote,
 * and an agent proposing the option "Other…" must not silently become the free
 * text box.
 */
const OTHER = "\u0000other";
const SUBMIT = "\u0000submit";

/** What this needs from `ctx.ui`; a test passes a double. */
export type AskUi = {
	custom<T>(factory: (tui: unknown, theme: Theme, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	readonly theme: Theme;
};

/** How many options are shown before the list starts scrolling. */
const MAX_VISIBLE = 8;

/**
 * Builds an `AskUser` backed by pi's TUI.
 *
 * `hasUI` is the caller's business: outside a terminal there is nobody to ask,
 * and an interview with no user is a submit on the first question.
 */
export function createAskUi(ui: AskUi): AskUser {
	return async (question: Question): Promise<Answer | undefined> => {
		const picked = await showCard(ui, question);
		if (picked === SUBMIT || picked === undefined) return undefined;

		if (picked === OTHER) {
			const typed = await ui.input(question.question, "your answer");
			// Escaping out of the free-text box goes back to meaning "enough":
			// the user has twice declined to pick, and asking again would loop.
			if (!typed?.trim()) return undefined;
			return { question: question.question, answer: typed.trim(), custom: true };
		}

		return { question: question.question, answer: picked, custom: false };
	};
}

/** One card. Resolves with the chosen label, a sentinel, or `undefined` on esc. */
function showCard(ui: AskUi, question: Question): Promise<string | undefined> {
	const theme = ui.theme;

	return ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));

		if (question.header) {
			container.addChild(new Text(theme.fg("muted", `[${question.header}]`), 1, 0));
		}
		container.addChild(new Text(theme.fg("toolTitle", theme.bold(question.question)), 1, 0));

		const list = new SelectList(items(question), MAX_VISIBLE, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(SUBMIT);
		container.addChild(list);

		container.addChild(new Text(theme.fg("dim", "↑↓ choose • enter answer • esc build with what you have"), 1, 0));
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				(tui as { requestRender(): void }).requestRender();
			},
		};
	});
}

/** The agent's options, then the two that are always there. */
export function items(question: Question): SelectItem[] {
	return [
		...question.options.map((choice) => ({
			value: choice.label,
			label: choice.label,
			description: choice.description,
		})),
		{ value: OTHER, label: "Other…", description: "type your own answer" },
		{ value: SUBMIT, label: "That's enough - build it", description: "stop asking and write the brief" },
	];
}

export { OTHER, SUBMIT };
