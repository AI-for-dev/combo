/**
 * Where pi comes in.
 *
 * pi hands this extension two things: an API to register through, and a
 * context on every call. This file names the slice of each that the extension
 * reads, and nothing else under `extension/` names pi's context types. A
 * command is written against {@link CommandCtx}; a test hands it a fake, and pi
 * hands it the whole `ExtensionCommandContext`. TypeScript checks at every
 * `registerCommand` and at the tool's `execute` that the whole has what the
 * slice reads, so when pi changes shape the extension compiles red - which is
 * the one way a fake can be trusted to stand in for it.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { StepDeps } from "./deps.ts";

/** The slice of pi's API this extension registers through, and speaks to a session with. */
export type PiApi = Pick<
	ExtensionAPI,
	"registerTool" | "registerCommand" | "registerMessageRenderer" | "registerEntryRenderer" | "sendMessage" | "appendEntry"
>;

/**
 * The slice of pi's `ctx.ui` the extension reads. Declared once, here.
 *
 * Every member is one pi has, under the name pi gives it. Narrower where pi is
 * wider - `setWidget` takes lines and never a component, `custom` erases the
 * TUI - so that a test's double stays small.
 */
export type Ui = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, lines: string[] | undefined): void;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	setEditorText(text: string): void;
	custom<T>(factory: (tui: unknown, theme: Theme, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T>;
	onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void;
	readonly theme: Theme;
};

/** What a command is handed. pi's own context has all of it, and a test builds one. */
export type CommandCtx = {
	cwd: string;
	/** Whether there is a terminal to ask anything in. */
	hasUI: boolean;
	/** pi's signal for the turn in flight, when a turn is: absent during a command. */
	signal?: AbortSignal;
	ui: Ui;
};

/** What the question card needs. */
export type AskUi = Pick<Ui, "custom" | "input" | "theme">;

/** The colour subset of pi's `Theme` the widget needs. */
export type WidgetTheme = { fg(colour: string, text: string): string };

/** What listening for a key needs. Both optional: a headless caller has neither. */
export type KeyUi = Partial<Pick<Ui, "onTerminalInput" | "notify">>;

/**
 * What a caller needs from pi to show a run.
 *
 * The setters are optional: the tool has no footer to write to, and a headless
 * caller has neither.
 */
export type RunUi = KeyUi & Partial<Pick<Ui, "setStatus" | "setWidget">> & { theme: WidgetTheme };

/**
 * What `/stop` needs from pi. A key has the same thing to say, through the same
 * words, and a headless terminal has nowhere to say it - hence optional.
 */
export type StopCtx = { ui: Partial<Pick<Ui, "notify">> };

/** What the tool body is handed by pi's tool context. */
export type ToolCtx = {
	cwd: string;
	ui: RunUi;
	/** Where pi keeps the parent session. Only this level can know. */
	sessionManager?: { getSessionFile(): string | undefined };
};

/** What pi shows while a tool call is in flight: text for the model, nothing for the renderers. */
export type ToolUpdate = { content: { type: "text"; text: string }[]; details: undefined };

/**
 * What the tool body reads off pi's tool context. `execute.ts` takes these and
 * more, all optional there; here they are what pi has, as pi has it.
 */
export type ToolDeps = {
	cwd: string;
	signal: AbortSignal | undefined;
	onUpdate: ((update: ToolUpdate) => void) | undefined;
	ui: RunUi;
	/**
	 * The parent session's JSONL, from `ctx.sessionManager.getSessionFile()`.
	 *
	 * An orchestration export that lost the parent session would be half a
	 * story - and the extension is the only place that knows this path.
	 */
	mainSessionFile: string | undefined;
};

/** The tool body's dependencies, read off what pi handed the tool. */
export function toolDeps(ctx: ToolCtx, signal: AbortSignal | undefined, onUpdate: ToolDeps["onUpdate"]): ToolDeps {
	return { cwd: ctx.cwd, signal, onUpdate, ui: ctx.ui, mainSessionFile: ctx.sessionManager?.getSessionFile() };
}

/**
 * The two doors a command has into the session, bound to pi.
 *
 * Bound here rather than at each `registerCommand`, so that a command's file
 * takes pi's API as a whole and never reaches into it.
 */
export function sessionDoors(pi: Pick<PiApi, "sendMessage" | "appendEntry">): Required<Pick<StepDeps, "sendMessage" | "appendEntry">> {
	return {
		sendMessage: (message) => pi.sendMessage(message),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	};
}
