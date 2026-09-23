/**
 * The question card: one question, its options, and two ways out.
 *
 * This is the pi implementation of the {@link AskUser} port. It owns the
 * terminal for the length of one question and gives it straight back - which is
 * why the interview can be driven from a slash command but never from a tool the
 * model calls: nobody can answer a question that is being asked inside a turn.
 *
 * Two entries are appended to the interview's card, exactly as Claude Code
 * does: **Other…** for a free answer, and **that's enough** to submit. The
 * second one is not a cancel - the answers already given still count, and the
 * brief is still written. `esc` means the same thing, so the reflex to escape
 * out of a dialog does not throw the conversation away - and for as long as a
 * card is up, `esc` means nothing else: the run's stop key is held, or the
 * interviewer who has to write the brief would be stopped by the same press.
 *
 * A flow's `ask` says more of its card, through {@link Asking}: a choice, a
 * yes or no or a free text, whether "enough" is offered and under which label,
 * and when it is not, `esc` is the run's stop, and the help line says so.
 */

import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import type { Answer, Asking, AskUser, Question } from "../../src/index.ts";
import type { AskUi } from "../pi.ts";
import { whileAsking } from "./asking.ts";
import { showCard, textBox, type Body } from "./card.ts";

/**
 * Sentinels for the two entries we add ourselves.
 *
 * A NUL prefix, not a plain string: the other values are labels a model wrote,
 * and an agent proposing the option "Other…" must not silently become the free
 * text box.
 */
const OTHER = "\u0000other";
const SUBMIT = "\u0000submit";

/** How many options are shown before the list starts scrolling. */
const MAX_VISIBLE = 8;

/** The label of "that's enough" when the card says none. */
const ENOUGH = "That's enough";

/**
 * Builds an `AskUser` backed by pi's TUI.
 *
 * Whether somebody is there is the caller's business: outside a terminal
 * there is nobody to ask, and an interview with no user is a submit on the
 * first question.
 */
export function createAskUi(ui: AskUi): AskUser {
	return (question, asking) => whileAsking(() => (asking === undefined ? interview(ui, question) : put(ui, question, asking)));
}

/** The interview's card, which `Other…` follows with pi's own text box. */
async function interview(ui: AskUi, question: Question): Promise<Answer | undefined> {
	const picked = await pick(ui, question, undefined, items(question));
	if (picked === SUBMIT || picked === undefined) return undefined;
	if (picked !== OTHER) return { question: question.question, answer: picked, custom: false };

	const typed = await ui.input(question.question, "your answer");
	// Escaping out of the free-text box goes back to meaning "enough":
	// the user has twice declined to pick, and asking again would loop.
	if (!typed?.trim()) return undefined;
	return { question: question.question, answer: typed.trim(), custom: true };
}

/** A card as `asking` puts it. `undefined` is declining it, or the card taken down by its signal. */
async function put(ui: AskUi, question: Question, asking: Asking): Promise<Answer | undefined> {
	const answer = (text: string, custom: boolean): Answer => ({ question: question.question, answer: text, custom });
	if (asking.form === "text") {
		const typed = await type(ui, question, asking, escapeHelp(asking));
		return typed === undefined ? undefined : answer(typed.trim(), true);
	}
	if (asking.form === "confirm") {
		const picked = await pick(ui, question, asking, YES_NO);
		return picked === undefined ? undefined : answer(picked, false);
	}
	for (;;) {
		const picked = await pick(ui, question, asking, items(question, asking));
		if (picked === SUBMIT || picked === undefined) return undefined;
		if (picked !== OTHER) return answer(picked, false);
		// Escaping out of the text box goes back to the options: where no
		// "enough" is offered, declining is the run's stop, and a key pressed to
		// leave a text box must not end a run.
		const typed = (await type(ui, question, asking, "esc back to the options"))?.trim();
		if (asking.signal?.aborted) return undefined;
		if (typed) return answer(typed, true);
	}
}

/** A list card: `entries`, one of them picked, `undefined` on `esc`. */
function pick(ui: AskUi, question: Question, asking: Asking | undefined, entries: SelectItem[]): Promise<string | undefined> {
	return showCard<string>(ui, { question, asking, help: ["↑↓ choose", "enter answer", escapeHelp(asking)] }, (close) => list(ui, entries, close));
}

/** A text card, settling with what was typed, `""` included; `escape` says what `esc` does there. */
function type(ui: AskUi, question: Question, asking: Asking, escape: string): Promise<string | undefined> {
	return showCard<string>(ui, { question, asking, help: ["enter answer", escape] }, textBox);
}

/** What `esc` does, as the help line says it: the interview's brief, "that's enough", or the run's stop. */
function escapeHelp(asking: Asking | undefined): string {
	if (asking === undefined) return "esc write the brief with what you have";
	return `esc ${asking.enough === false ? "stop the run" : (asking.enough ?? ENOUGH)}`;
}

const YES_NO: SelectItem[] = [
	{ value: "yes", label: "Yes" },
	{ value: "no", label: "No" },
];

/**
 * The options, then what is always there: `Other…` unless the card is closed,
 * and "that's enough" unless `asking.enough` is `false`.
 */
export function items(question: Question, asking?: Asking): SelectItem[] {
	const other = asking?.form === "closed" ? [] : [{ value: OTHER, label: "Other…", description: "type your own answer" }];
	const enough = asking === undefined
		? [{ value: SUBMIT, label: ENOUGH, description: "stop asking and write the brief" }]
		: asking.enough === false ? [] : [{ value: SUBMIT, label: asking.enough ?? ENOUGH }];
	return [
		...question.options.map((choice) => ({ value: choice.label, label: choice.label, description: choice.description })),
		...other,
		...enough,
	];
}

function list(ui: AskUi, entries: SelectItem[], close: (value: string | undefined) => void): Body {
	const theme = ui.theme;
	const select = new SelectList(entries, MAX_VISIBLE, {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	});
	select.onSelect = (item) => close(item.value);
	select.onCancel = () => close(undefined);
	return select;
}

export { OTHER, SUBMIT };
