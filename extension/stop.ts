/**
 * Stopping subagents from the terminal: the key, the selection, the command.
 *
 * A run is stoppable because `liveRun` hands its {@link StopSwitch} over here
 * while it lasts. Which one a key acts on is the only thing this file decides,
 * and it decides it the plain way: **the run that started last**. Two at once is
 * already the unusual case - a command launched while a tool call works - and
 * the newest is the one whose dots are on screen.
 *
 * Escape is **listened to, never consumed**. pi binds it to `app.interrupt`,
 * which aborts the turn a tool call runs inside; swallowing it would leave the
 * model free to delegate again the moment the tool returned. During a command
 * pi's own handler finds no run to abort, and this is what stops the subagents
 * then. One key, one meaning, wherever it is pressed.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseKey } from "@earendil-works/pi-tui";
import type { StopSwitch, TuiSnapshot } from "../src/index.ts";
import { treeOrder } from "../src/index.ts";

/** A run that can still be stopped, as the terminal sees it. */
export type LiveRun = {
	/** What actually stops it. */
	readonly stop: StopSwitch;
	/** Its current state - the list a selection moves through. */
	snapshot(): TuiSnapshot;
	/** Redraws the widget, so a moved selection shows at once. */
	repaint(): void;
	/** The subagent the next bare `/stop` acts on. */
	selected?: string;
};

/** What the key listener needs from pi. Narrow, so a test can stand in for it. */
export type KeyUi = {
	onTerminalInput?(handler: (data: string) => { consume?: boolean } | undefined): () => void;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
};

/** What `/stop` needs from pi. A key has the same thing to say, through the same words. */
export type StopCtx = { ui: { notify?(message: string, type?: "info" | "warning" | "error"): void } };

/** Registers `/stop`. The key listener needs no registration: a run brings it. */
export default function registerStopCommand(pi: ExtensionAPI) {
	pi.registerCommand("stop", {
		description: "Stop the selected subagent - `<id>` names one, `all` stops the run (esc does that too)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			stopCommand(args, ctx as unknown as StopCtx);
		},
	});
}

/** The runs still going, oldest first. Empty between two runs, which is the common case. */
const running: LiveRun[] = [];

/** Undoes the terminal subscription. Present exactly while `running` is not empty. */
let unlisten: (() => void) | undefined;

/** The pi the keys are read from, and answered to. Set with the first run. */
let terminal: KeyUi | undefined;

/**
 * Watches a run for as long as it lasts.
 *
 * The listener is attached with the first run and dropped with the last: outside
 * a run this file reads no keys at all, which is what keeps Escape and ctrl+↑↓
 * behaving exactly as pi means them to.
 */
export function watchRun(run: LiveRun, ui: KeyUi | undefined): void {
	running.push(run);
	if (!unlisten && ui?.onTerminalInput) {
		terminal = ui;
		unlisten = ui.onTerminalInput(onKey);
	}
}

/** Stops watching. Call it in the same `finally` that takes the widget down. */
export function forgetRun(run: LiveRun): void {
	const index = running.indexOf(run);
	if (index >= 0) running.splice(index, 1);
	if (running.length === 0) {
		unlisten?.();
		unlisten = undefined;
		terminal = undefined;
	}
}

/** The run a key or a bare `/stop` acts on: the one that started last. */
export function currentRun(): LiveRun | undefined {
	return running.at(-1);
}

/**
 * Escape stops everything; ctrl+↑↓ walk the list; ctrl+del stops what they
 * landed on.
 *
 * Those three are consumed, because they are ours for the length of a run and
 * bound to nothing in pi, whereas Escape belongs to pi and is merely overheard.
 *
 * ctrl+del does what `/stop` does, and it exists because `/stop` cannot always
 * be typed: pi runs no submission while a slash command of its own is awaiting,
 * so during `/run` or `/build` a key is the only way in. During a tool call
 * either works.
 */
function onKey(data: string): { consume?: boolean } | undefined {
	switch (parseKey(data)) {
		case "escape":
			stopEverything();
			return undefined;
		case "ctrl+up":
			moveSelection(-1);
			return { consume: true };
		case "ctrl+down":
			moveSelection(1);
			return { consume: true };
		case "ctrl+delete":
			stopCommand("", { ui: terminal ?? {} });
			return { consume: true };
		default:
			return undefined;
	}
}

/** Stops every live run. Returns how many were going. */
export function stopEverything(): number {
	const count = running.length;
	for (const run of running) run.stop.all();
	return count;
}

/**
 * Moves the selection by `delta` among the subagents still working.
 *
 * It wraps, and it starts at the first one: with nothing selected the first
 * ctrl+↑ or ctrl+↓ lands somewhere rather than on nothing. A selection whose
 * subagent has finished in the meantime is treated as no selection - the row it
 * pointed at is no longer stoppable.
 */
export function moveSelection(delta: number): string | undefined {
	const run = currentRun();
	if (!run) return undefined;

	const ids = stoppable(run.snapshot());
	if (ids.length === 0) {
		run.selected = undefined;
		return undefined;
	}

	const from = run.selected ? ids.indexOf(run.selected) : -1;
	const next = from < 0 ? (delta > 0 ? 0 : ids.length - 1) : (from + delta + ids.length) % ids.length;
	run.selected = ids[next];
	run.repaint();
	return run.selected;
}

/** The ids a stop would reach, in the order the widget draws them. */
export function stoppable(snapshot: TuiSnapshot): string[] {
	return treeOrder(snapshot.subagents)
		.filter((row) => row.snapshot.status !== "done")
		.map((row) => row.snapshot.id);
}

/**
 * `/stop` - the selected subagent, one named by id, or the lot.
 *
 * A command beside the keys because a key cannot name anything: this is how a
 * branch is called off by id rather than by pointing at it. It runs at once
 * while a tool call works - pi executes an extension command instead of queueing
 * it - and ctrl+del is what covers the rest.
 */
export function stopCommand(args: string, ctx: StopCtx): string {
	const word = args.trim();
	const run = currentRun();
	if (!run) return say(ctx, "stop: nothing is running", "warning");

	if (word === "all") {
		const count = stopEverything();
		return say(ctx, `stop: stopping ${count > 1 ? `${count} runs` : "the run"} - what ran so far is kept`, "info");
	}

	const ids = stoppable(run.snapshot());
	const target = word || run.selected || (ids.length === 1 ? ids[0] : undefined);
	if (!target) {
		return say(ctx, `stop: ctrl+↑/↓ picks one of ${ids.join(", ")}, \`/stop <id>\` names it, esc stops the run`, "warning");
	}

	// Any live run, not only the current one: an id is unambiguous, and a user
	// reading two runs' dots should not have to know which is the newest. A
	// subagent that has finished since is refused rather than stopped, or a
	// selection left on a done row would report work that never happened.
	const owner = running.find((one) => stoppable(one.snapshot()).includes(target) && one.stop.one(target));
	if (!owner) {
		return say(ctx, `stop: no subagent \`${target}\` is running${ids.length ? ` - try ${ids.join(", ")}` : ""}`, "warning");
	}

	if (owner.selected === target) owner.selected = undefined;
	owner.repaint();
	return say(ctx, `stop: ${target} stopped - the other subagents are untouched`, "info");
}

function say(ctx: StopCtx, message: string, type: "info" | "warning" | "error"): string {
	ctx.ui.notify?.(message, type);
	return message;
}
