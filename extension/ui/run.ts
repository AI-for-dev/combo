/**
 * What everything that runs subagents needs while they work: the dots, the
 * footer, the transcripts.
 *
 * It exists because the `subagent` tool, `/run` and `/step` must look
 * **identical** while they run. They had every reason to drift - three call
 * sites, three timers, three ways of clearing a widget - and the one that drifts
 * is the one nobody is watching that day. One painter, one `finally`, one
 * report. A run that walks a flow draws the flow's plan in the same widget,
 * through `flow.ts`, and everything else about it is the same.
 *
 * Painting lives here rather than in `execute.ts` so the dependency runs one
 * way: the tool body and the commands both reach for this file, and it reaches
 * for none of them.
 */

import {
	createHerdrReporter,
	isVisit,
	livePlan,
	measuredRun,
	statusColour,
	stopSwitch,
	widgetRows,
	type CheckedFlow,
	type EventListener,
	type JournalEntry,
	type RunPicture,
	type RunSnapshot,
	type SpawnFn,
	type SubagentEvent,
} from "../../src/index.ts";
import { planWidget } from "./flow.ts";
import { watchEverything } from "./herdr-switch.ts";
import type { RunUi, WidgetTheme } from "../pi.ts";
import { forgetRun, watchRun } from "../commands/index.ts";

/** Key for the footer status and the widget above the prompt. */
export const STATUS = "combo";

/** How often the widget repaints while subagents are working, in ms. */
const TICK_MS = 250;

/** What a caller may vary about a live run. Everything else is the same everywhere. */
export type LiveRunOptions = {
	/**
	 * Widget repaint period. `0` disables the timer - tests want that.
	 *
	 * A period rather than a redraw on every event: `busyMs` only lands when a
	 * turn ends, so a subagent thinking for twenty seconds emits nothing at all,
	 * and a frozen clock reads as a hung agent.
	 */
	tickMs?: number;
	/**
	 * A second observer beside the picture.
	 *
	 * Defaults to the herdr reporter, which is `undefined` unless pi itself runs
	 * inside herdr. Injected so the wiring is testable offline - a herdr reporter
	 * nobody subscribed is one of the bugs that reached a user through here.
	 */
	reporter?: EventListener;
	/** Give every subagent of this run a split, not only the ones that asked. */
	herdrAll?: boolean;
	/** Called on every event, after the widget: the tool streams a progress line. */
	onChange?: (snapshot: RunSnapshot) => void;
	/**
	 * The caller's own signal - pi's, when it has one.
	 *
	 * It is folded into {@link LiveRun.signal} rather than passed to the workflow
	 * directly, so that a run has **one** thing to obey whether it was called off
	 * by pi, by Escape or by `/stop all`.
	 */
	signal?: AbortSignal;
	/** The `spawn` the run should use. Defaults to the real one. */
	spawn?: SpawnFn;
	/** Where `usage.json` lands when the run is over. Absent writes none. */
	dir?: string;
	/** The parent session's JSONL, from `ctx.sessionManager.getSessionFile()`, copied in beside the subagents' transcripts. */
	mainSessionFile?: string;
	/**
	 * The flow this run walks, and what its earlier lives wrote in its
	 * journal: the widget then draws its plan, filled as the visits go,
	 * rather than a row per subagent.
	 */
	flow?: { readonly checked: CheckedFlow; readonly journal: readonly JournalEntry[] };
};

/** A live view of a run, and the one call that takes it down. */
export type LiveRun = {
	/** Subscribe this to the workflow: the TUI picture and herdr, composed. */
	onEvent: EventListener;
	/** The state the widget is drawn from, and the usage report is built from. */
	picture: RunPicture;
	/** Give the workflow this signal, not the caller's: Escape fires it too. */
	signal: AbortSignal;
	/** Give the workflow this `spawn`: it is what makes one subagent stoppable. */
	spawn: SpawnFn;
	/** How long the view has been up. The run's wall time, measured once, here. */
	elapsedMs(): number;
	/**
	 * Clears the footer and the widget, and closes the measurement: the run's
	 * `usage.json`, with the time this view measured, when a `dir` was given.
	 *
	 * Call it in a `finally`: a thrown workflow must not leave a dead row of dots
	 * above the prompt for the rest of the session, and a run that was cancelled
	 * still has work worth keeping.
	 */
	stop(): void;
};

/** Starts painting a run. `ui` is absent for a headless caller: nothing is drawn. */
export function liveRun(ui: RunUi | undefined, options: LiveRunOptions = {}): LiveRun {
	// What a flow's plan is folded from: the visits, and the spawns naming them.
	// Text and tool calls come by the thousand, and the fold reads none of them.
	const told: SubagentEvent[] = [];
	const { flow } = options;
	const plan = () => (flow === undefined ? undefined : livePlan(flow.checked, flow.journal, told));
	// A view is a measured run with a terminal on top. `herdrAll` belongs to the
	// reporter, not to the spawn: whether a pane opens is a display decision,
	// and the workflow runs identically either way.
	const run = measuredRun({
		dir: options.dir,
		mainSessionFile: options.mainSessionFile,
		listeners: [
			options.reporter ?? createHerdrReporter({ all: options.herdrAll || watchEverything() }),
			flow &&
				((event) => {
					if (event.type !== "spawn" && !isVisit(event)) return;
					told.push(event);
					paint();
				}),
		],
	});
	const { picture } = run;

	const stopping = stopSwitch({ signal: options.signal, spawn: options.spawn });
	const paint = () => {
		if (!ui?.setWidget) return;
		const now = plan();
		const selected = watched.selected;
		if (now === undefined) return ui.setWidget(STATUS, paintWidget(picture.snapshot(), ui.theme, selected));
		ui.setWidget(STATUS, planWidget(now, ui.theme, { snapshot: picture.snapshot(), selected }, hint(now.summary.state === "working", ui.theme)));
	};
	// The terminal reads the selection from here and writes it back: a run is
	// what a key acts on, and it is the only thing that knows when it is over.
	const watched = { stop: stopping, snapshot: () => picture.snapshot(), repaint: paint, selected: undefined as string | undefined };
	watchRun(watched, ui);

	picture.onChange(() => {
		paint();
		options.onChange?.(picture.snapshot());
	});

	const tickMs = options.tickMs ?? TICK_MS;
	const tick = tickMs > 0 ? setInterval(paint, tickMs) : undefined;
	tick?.unref?.();

	return {
		onEvent: run.onEvent,
		picture,
		signal: stopping.signal,
		spawn: stopping.spawn,
		elapsedMs: run.elapsedMs,
		stop() {
			forgetRun(watched);
			if (tick) clearInterval(tick);
			ui?.setStatus?.(STATUS, undefined);
			// The widget lives only while the work does: the summary is one line
			// up, in the tool row, and nothing should pile up above the prompt
			// between two requests.
			ui?.setWidget?.(STATUS, undefined);
			run.finish();
		},
	};
}

/**
 * Paints the dots that sit above the prompt.
 *
 * The lines themselves come from `widgetRows`, which knows nothing about
 * colour; this only applies the theme, and marks the selected row. Keeping the
 * two apart is what lets the layout be tested without a terminal - a selection
 * is a fact about this terminal, and lives no deeper than the paint.
 */
export function paintWidget(snapshot: RunSnapshot, theme: WidgetTheme, selected?: string): string[] {
	const lines = widgetRows(snapshot).map((row) => {
		// A delegated subagent sits under the one that asked for it, live and in
		// the table alike: the tree is what the run costs, so it is what it looks
		// like while it runs.
		const indent = "  ".repeat(row.depth);
		if (row.kind === "detail") return `${indent}  ${theme.fg("dim", row.text)}`;

		// Marked only while it could still be stopped: a pointer left on a row
		// that has finished offers something that is no longer there.
		const marked = row.id === selected && row.status !== "done";
		const dot = marked ? theme.fg("accent", "▸") : theme.fg(statusColour(row.status), row.icon);
		const id = theme.fg(marked ? "accent" : "toolTitle", row.id);
		// The id carries the weight; the activity is deliberately quiet, and the
		// numbers of a finished subagent are quieter still - they sit where its
		// second line used to be, on the same line.
		const said = [row.activity && theme.fg("muted", row.activity), row.detail && theme.fg("dim", row.detail)].filter(Boolean);
		return [`${indent}${dot} ${id}`, ...said].join("  ");
	});

	return [...lines, ...hint(snapshot.done < snapshot.total, theme)];
}

/** {@link HINT}, while there is something left to stop. */
function hint(running: boolean, theme: WidgetTheme): string[] {
	return running ? [theme.fg("muted", HINT)] : [];
}

/**
 * What a reader can do about the run they are watching.
 *
 * Spelled out under the dots rather than left to a `--help`: a key nobody knows
 * about is a key nobody presses, and this one exists for the moment where the
 * run has gone wrong and reading documentation is the last thing on anyone's
 * mind. `esc` is pi's own interrupt, so it is not ours to rename.
 */
const HINT = "esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one";
