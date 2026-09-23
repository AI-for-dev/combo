/**
 * The `CommandCtx` the extension's commands are tested against.
 *
 * Every command takes the same narrow slice of pi - notify, status, widget,
 * editor, confirm - and every test on one wants the same thing back: what the
 * user was shown, and what they were asked. One double, so a command added
 * tomorrow does not arrive with a fourth copy of this and its own idea of what
 * `confirm` answers when the script runs out.
 */

import type { CommandCtx } from "../../extension/pi.ts";
import { testTheme } from "./theme.ts";

/** Answers the double gives, in order. Past the end, it falls back to the prefill. */
export type ScriptedAnswers = { confirm?: boolean[]; editor?: (string | undefined)[] };

/** Records everything the command showed, and answers as the script says. */
export function fakeCtx(answers: ScriptedAnswers = {}) {
	const notes: { message: string; type?: string }[] = [];
	const confirms: string[] = [];
	const editors: string[] = [];
	const widgets: (string[] | undefined)[] = [];
	const statuses: (string | undefined)[] = [];
	const inputs: string[] = [];
	let editorText = "";

	const confirmAnswers = [...(answers.confirm ?? [])];
	const editorAnswers = [...(answers.editor ?? [])];

	const theme = testTheme();
	const ctx: CommandCtx = {
		cwd: "/repo",
		mode: "tui",
		ui: {
			theme,
			async custom<T>(): Promise<T> {
				throw new Error("the card must not be reached: whatever asks is injected");
			},
			async input(title: string) {
				inputs.push(title);
				return undefined;
			},
			notify: (message, type) => void notes.push({ message, type }),
			setStatus: (_key, text) => void statuses.push(text),
			// A widget given as a component is drawn as pi would, 120 columns wide.
			setWidget: (_key, content) => void widgets.push(typeof content === "function" ? content(undefined, theme).render(120) : content),
			async editor(title, prefill) {
				editors.push(title);
				return editorAnswers.length ? editorAnswers.shift() : prefill;
			},
			async confirm(title) {
				confirms.push(title);
				return confirmAnswers.length ? Boolean(confirmAnswers.shift()) : true;
			},
			setEditorText: (text) => void (editorText = text),
			// A run wires its keys here; the test presses none.
			onTerminalInput: () => () => {},
		},
	};

	return {
		ctx,
		notes,
		confirms,
		editors,
		widgets,
		statuses,
		inputs,
		/** Everything the user was told, as one string - what most assertions match on. */
		said: () => notes.map((note) => note.message).join("\n"),
		editorText: () => editorText,
	};
}
