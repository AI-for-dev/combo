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

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { MainSession } from "../src/index.ts";
import type { StepDeps } from "./deps.ts";

/** How pi runs: `"tui"`, `"rpc"`, `"json"` or `"print"`. */
type Mode = ExtensionContext["mode"];

/** The slice of pi's API this extension registers through, and speaks to a session with. */
export type PiApi = Pick<
	ExtensionAPI,
	"registerTool" | "registerCommand" | "registerMessageRenderer" | "registerEntryRenderer" | "sendMessage" | "appendEntry"
>;

/**
 * The slice of pi's `ctx.ui` the extension reads. Declared once, here.
 *
 * Every member is one pi has, under the name pi gives it. Narrower where pi is
 * wider - a widget's component is drawn without the TUI, `custom` erases it -
 * so that a test's double stays small.
 */
export type Ui = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, lines: string[] | undefined): void;
	/**
	 * A widget drawn at the width pi gives it. pi cuts one given as lines at
	 * ten, and wraps each past the terminal's edge: a flow's plan is taller,
	 * and wants cutting where it knows what it cuts.
	 */
	setWidget(key: string, widget: Widget | undefined): void;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	setEditorText(text: string): void;
	custom<T>(factory: (tui: unknown, theme: Theme, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T>;
	onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void;
	readonly theme: Theme;
};

/** A widget as a component: what pi draws above the editor, at the width it has. */
export type Widget = (tui: unknown, theme: Theme) => { render(width: number): string[]; invalidate(): void };

/** What a command is handed. pi's own context has all of it, and a test builds one. */
export type CommandCtx = {
	cwd: string;
	/** How pi runs: {@link somebodyThere} reads it. */
	mode: Mode;
	/** pi's signal for the turn in flight, when a turn is: absent during a command. */
	signal?: AbortSignal;
	ui: Ui;
	/** This session, whose JSONL a run writes in beside its subagents'. */
	sessionManager?: MainSession;
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
	/** How pi runs: {@link somebodyThere} reads it. */
	mode: Mode;
	ui: RunUi & AskUi;
	/** The parent session. Only this level can know it. */
	sessionManager?: MainSession;
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
	/** How pi runs: a flow's question cards are shown during the turn when {@link somebodyThere} says so. */
	mode: Mode;
	ui: RunUi & AskUi;
	/**
	 * The parent session, `ctx.sessionManager`.
	 *
	 * An orchestration export that lost the parent session would be half a
	 * story - and the extension is the only place that has it.
	 */
	mainSession: MainSession | undefined;
};

/** The tool body's dependencies, read off what pi handed the tool. */
export function toolDeps(ctx: ToolCtx, signal: AbortSignal | undefined, onUpdate: ToolDeps["onUpdate"]): ToolDeps {
	return { cwd: ctx.cwd, signal, onUpdate, mode: ctx.mode, ui: ctx.ui, mainSession: ctx.sessionManager };
}

/**
 * Whether somebody is there to answer a question card: only in pi's terminal.
 *
 * Not `ctx.hasUI`, which RPC mode sets too: its dialogs go to the client, but
 * `custom()`, which draws the card, returns `undefined` there, and a card
 * nobody saw would read as declined - "that's enough", or the run's stop.
 * Outside the terminal a flow's `ask` takes its nobody-there path instead.
 */
export function somebodyThere(ctx: { mode?: Mode }): boolean {
	return ctx.mode === "tui";
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
