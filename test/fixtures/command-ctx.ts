/**
 * The `CommandCtx` the extension's commands are tested against.
 *
 * Every command takes the same narrow slice of pi - notify, status, widget,
 * editor, confirm - and every test on one wants the same thing back: what the
 * user was shown, and what they were asked. One double, so a command added
 * tomorrow does not arrive with a fourth copy of this and its own idea of what
 * `confirm` answers when the script runs out.
 */

import type { CommandCtx } from "../../extension/command.ts";
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

	const ctx: CommandCtx = {
		cwd: "/repo",
		hasUI: true,
		ui: {
			theme: testTheme(),
			async custom<T>(): Promise<T> {
				throw new Error("the card must not be reached: whatever asks is injected");
			},
			async input(title: string) {
				inputs.push(title);
				return undefined;
			},
			notify: (message, type) => void notes.push({ message, type }),
			setStatus: (_key, text) => void statuses.push(text),
			setWidget: (_key, lines) => void widgets.push(lines),
			async editor(title, prefill) {
				editors.push(title);
				return editorAnswers.length ? editorAnswers.shift() : prefill;
			},
			async confirm(title) {
				confirms.push(title);
				return confirmAnswers.length ? Boolean(confirmAnswers.shift()) : true;
			},
			setEditorText: (text) => void (editorText = text),
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
