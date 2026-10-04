/**
 * Stopping subagents from the terminal: the key, the selection, the command.
 *
 * A run is stoppable because `liveRun` hands its {@link StopSwitch} over here
 * while it lasts. Which one a key acts on is the only thing this file decides,
 * and it decides it the plain way: **the run that started last**. Two at once is
 * already the unusual case - a command launched while a tool call works - and
 * the newest is the one whose dots are on screen.
 *
 * The keys are `keys.ts`'s, rebindable in pi's `keybindings.json`; their
 * defaults are named below. The stop key is **listened to, never consumed**.
 * By default it is Escape, which pi binds to `app.interrupt`: that aborts the
 * turn a tool call runs inside, and swallowing the key would leave the model
 * free to delegate again the moment the tool returned. During a command pi's
 * own handler finds no run to abort, and this is what stops the subagents
 * then. One key, one meaning, wherever it is pressed - with one exception, a
 * question card, which owns the key for as long as it is on screen; that is
 * `asking.ts`.
 */


import type { StopSwitch, RunSnapshot } from "../../src/index.ts";
import { treeOrder } from "../../src/index.ts";
import { isAsking } from "../ui/index.ts";
import { pressed, showKeys } from "../keys.ts";
import type { KeyUi, PiApi, StopCtx } from "../pi.ts";

/** A run that can still be stopped, as the terminal sees it. */
export type LiveRun = {
	/** What actually stops it. */
	readonly stop: StopSwitch;
	/** Its current state - the list a selection moves through. */
	snapshot(): RunSnapshot;
	/** Redraws the widget, so a moved selection shows at once. */
	repaint(): void;
	/** The subagent the next bare `/stop` acts on. */
	selected?: string;
};

/** Registers `/stop`. The key listener needs no registration: a run brings it. */
export default function registerStopCommand(pi: PiApi) {
	// No key named here: a description is written once, as the extension loads,
	// and a key rebound after that would leave it saying the wrong one.
	pi.registerCommand("stop", {
		description: "Stop the selected subagent - `<id>` names one, `all` stops the run",
		handler: async (args, ctx: StopCtx) => {
			stopCommand(args, ctx);
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
 * a run this file reads no keys at all, which is what keeps Escape behaving
 * exactly as pi means it to.
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
 * Escape stops everything; shift+↑↓ walk the list; ctrl+del stops what they
 * landed on.
 *
 * The last three are consumed, because they are ours for the length of a run
 * and bound to nothing in pi, whereas the stop key may be pi's and is merely
 * overheard. A key is read when it is pressed, so a binding changed and
 * reloaded applies to the next press.
 *
 * ctrl+del does what `/stop` does, and it exists because `/stop` cannot always
 * be typed: pi runs no submission while a slash command of its own is awaiting,
 * so during `/run` or `/step` a key is the only way in. During a tool call
 * either works.
 */
function onKey(data: string): { consume?: boolean } | undefined {
	if (pressed(data, "combo.run.stop")) {
		if (!isAsking()) stopEverything();
		return undefined;
	}
	if (pressed(data, "combo.subagent.previous")) {
		moveSelection(-1);
		return { consume: true };
	}
	if (pressed(data, "combo.subagent.next")) {
		moveSelection(1);
		return { consume: true };
	}
	if (pressed(data, "combo.subagent.stop")) {
		stopCommand("", { ui: terminal ?? {} });
		return { consume: true };
	}
	return undefined;
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
 * key lands somewhere rather than on nothing. A selection whose
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
export function stoppable(snapshot: RunSnapshot): string[] {
	return treeOrder(snapshot.subagents)
		.filter((one) => one.status !== "done")
		.map((one) => one.id);
}

/**
 * `/stop` - the selected subagent, one named by id, or the lot.
 *
 * A command beside the keys because a key cannot name anything: this is how a
 * branch is called off by id rather than by pointing at it. It runs at once
 * while a tool call works - pi executes an extension command instead of queueing
 * it - and the selected-subagent key covers the rest.
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
		// Only the keys that are bound: a way offered that does nothing is worse than none.
		const select = [showKeys("combo.subagent.previous"), showKeys("combo.subagent.next")].filter(Boolean).join("/");
		const stop = showKeys("combo.run.stop");
		const ways = [select ? `${select} picks one of ${ids.join(", ")}, \`/stop <id>\` names it` : `\`/stop <id>\` names one of ${ids.join(", ")}`, ...(stop ? [`${stop} stops the run`] : [])];
		return say(ctx, `stop: ${ways.join(", ")}`, "warning");
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
