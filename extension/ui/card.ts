/**
 * One question card on screen: what is shown around the answer, and how it
 * comes down.
 *
 * What takes the answer - a list, a text box - is the caller's; the card draws
 * the rest the same way for every form: the header and the visit asking, the
 * reads above the question, the question, and a help line saying what the keys
 * do. A card also comes down when its question no longer stands, so a timeout
 * or a stop never leaves one on screen with nobody reading its answer.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Asking, Question } from "../../src/index.ts";
import type { AskUi } from "../pi.ts";

/** What a card is about, beside what takes the answer. */
export type Face = {
	readonly question: Question;
	readonly asking?: Asking;
	/** The help line, one key and what it does per entry. */
	readonly help: readonly string[];
};

/** What takes the answer: drawn in the card, handed every key, and settling with `close`. */
export type Body = Component & { handleInput(data: string): void; focused?: boolean };

/**
 * Shows `face` around the body `answer` builds, until the body settles or
 * `face.asking.signal` aborts, which settles it `undefined`.
 */
export function showCard<T>(ui: AskUi, face: Face, answer: (close: (value: T | undefined) => void) => Body): Promise<T | undefined> {
	const signal = face.asking?.signal;
	if (signal?.aborted) return Promise.resolve(undefined);

	return ui.custom<T | undefined>((tui, _theme, _keybindings, done) => {
		const abort = () => close(undefined);
		const close = (value: T | undefined) => {
			signal?.removeEventListener("abort", abort);
			done(value);
		};
		signal?.addEventListener("abort", abort, { once: true });

		const body = answer(close);
		const container = new Container();
		for (const child of [...top(ui, face), indented(body), new Spacer(1), help(ui, face.help), new Spacer(1), border(ui)]) container.addChild(child);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				body.handleInput(data);
				(tui as { requestRender(): void }).requestRender();
			},
			// The hardware cursor goes where the text box is, for an input method to follow.
			set focused(value: boolean) {
				body.focused = value;
			},
			get focused() {
				return body.focused ?? false;
			},
			dispose: () => signal?.removeEventListener("abort", abort),
		};
	});
}

/** A one-line text box, settling with what was typed on `enter` and `undefined` on `esc`. */
export function textBox(close: (value: string | undefined) => void): Body {
	const input = new Input();
	input.onSubmit = (value) => close(value);
	input.onEscape = () => close(undefined);
	return input;
}

/** Everything above what takes the answer. */
function top(ui: AskUi, { question, asking }: Face): Component[] {
	const theme = ui.theme;
	const chip = [question.header && theme.fg("muted", `[${question.header}]`), asking?.visit && theme.fg("dim", asking.visit)].filter(Boolean).join("  ");
	const shown = (asking?.context ?? []).flatMap(({ name, body }) => [
		new Text(theme.fg("accent", name), 1, 0),
		new Text(body.trim() === "" ? theme.fg("dim", "(empty)") : body, 3, 0),
		new Spacer(1),
	]);
	return [
		border(ui),
		new Spacer(1),
		...(chip === "" ? [] : [new Text(chip, 1, 0), new Spacer(1)]),
		...shown,
		new Text(theme.fg("toolTitle", theme.bold(question.question)), 1, 0),
		new Spacer(1),
	];
}

/** `body` one column in, where pi's own dialogs draw their options: neither `SelectList` nor `Input` pads itself. */
function indented(body: Body): Component {
	return { render: (width: number) => body.render(width - 1).map((line) => ` ${line}`), invalidate: () => body.invalidate() };
}

/** The keys on one line, or one key a line where they do not fit: never a key cut from what it does. */
function help(ui: AskUi, keys: readonly string[]): Component {
	const line = keys.join(" • ");
	const one = new Text(ui.theme.fg("dim", line), 1, 0);
	const each = new Text(ui.theme.fg("dim", keys.join("\n")), 1, 0);
	return {
		render: (width: number) => (visibleWidth(line) + 2 <= width ? one : each).render(width),
		invalidate: () => [one, each].forEach((text) => text.invalidate()),
	};
}

function border(ui: AskUi): Component {
	return new DynamicBorder((line: string) => ui.theme.fg("accent", line));
}
