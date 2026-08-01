/**
 * What everything that runs subagents needs while they work: the dots, the
 * footer, the transcripts.
 *
 * It exists because the `subagent` tool, `/build` and `/run` must look
 * **identical** while they run. They had every reason to drift - three call
 * sites, three timers, three ways of clearing a widget - and the one that drifts
 * is the one nobody is watching that day. One painter, one `finally`, one
 * report.
 *
 * Painting lives here rather than in `execute.ts` so the dependency runs one
 * way: the tool body and the commands both reach for this file, and it reaches
 * for none of them.
 */

import {
	combineReporters,
	commandVerifier,
	copyMainSession,
	createHerdrReporter,
	createTuiCollector,
	usageReport,
	widgetRows,
	writeUsageReport,
	type EventListener,
	type Pipeline,
	type TuiSnapshot,
	type Verify,
} from "../src/index.ts";

/** Key for the footer status and the widget above the prompt. */
export const STATUS = "combo";

/** How often the widget repaints while subagents are working, in ms. */
const TICK_MS = 250;

/** The colour subset of pi's `Theme` the widget needs. */
export type WidgetTheme = { fg(colour: string, text: string): string };

/**
 * What a caller needs from pi to show a run. A narrow slice, so a test can
 * stand in for it.
 *
 * Both setters are optional: the tool has no footer to write to, and a headless
 * caller has neither.
 */
export type RunUi = {
	theme: WidgetTheme;
	setStatus?(key: string, text: string | undefined): void;
	setWidget?(key: string, lines: string[] | undefined): void;
};

/**
 * Session-wide "open a herdr split for every subagent".
 *
 * A module-level switch rather than an argument threaded everywhere: it is a
 * preference about this terminal, it survives across tool calls and commands,
 * and `/herdr on` is how a user sets it without touching a single call site.
 * It starts off: nothing ambient turns it on.
 */
let watchAll = false;

/** Whether every subagent currently gets a split. */
export function watchEverything(): boolean {
	return watchAll;
}

/** Turns session-wide watching on or off. Returns the new state. */
export function watchEverythingIs(on: boolean): boolean {
	watchAll = on;
	return watchAll;
}

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
	 * A second observer beside the collector.
	 *
	 * Defaults to the herdr reporter, which is `undefined` unless pi itself runs
	 * inside herdr. Injected so the wiring is testable offline - a herdr reporter
	 * nobody subscribed is one of the bugs that reached a user through here.
	 */
	reporter?: EventListener;
	/** Give every subagent of this run a split, not only the ones that asked. */
	herdrAll?: boolean;
	/** Called on every event, after the widget: the tool streams a progress line. */
	onChange?: (snapshot: TuiSnapshot) => void;
	/**
	 * The parent session's JSONL, from `ctx.sessionManager.getSessionFile()`.
	 *
	 * Copied in beside the subagents' transcripts, because an export that lost
	 * the parent session would be half a story - and the extension is the only
	 * place that knows this path.
	 */
	mainSessionFile?: string;
};

/** A live view of a run, and the one call that takes it down. */
export type LiveRun = {
	/** Subscribe this to the workflow: the TUI collector and herdr, composed. */
	onEvent: EventListener;
	/** The state the widget is drawn from, and the usage report is built from. */
	collector: ReturnType<typeof createTuiCollector>;
	/**
	 * Clears the footer and the widget, and writes the run's `usage.json`.
	 *
	 * Call it in a `finally`: a thrown workflow must not leave a dead row of dots
	 * above the prompt for the rest of the session, and a run that was cancelled
	 * still has work worth keeping.
	 */
	stop(exportDir: string | undefined, wallMs: number): void;
};

/** Starts painting a run. `ui` is absent for a headless caller: nothing is drawn. */
export function liveRun(ui: RunUi | undefined, options: LiveRunOptions = {}): LiveRun {
	const collector = createTuiCollector();
	const onEvent = combineReporters(
		collector.reporter,
		// `herdrAll` belongs to the reporter, not to the spawn: whether a pane
		// opens is a display decision, and the workflow runs identically either way.
		options.reporter ?? createHerdrReporter({ all: options.herdrAll || watchEverything() }),
	);

	const paint = () => ui?.setWidget?.(STATUS, paintWidget(collector.snapshot(), ui.theme));
	collector.onChange(() => {
		paint();
		options.onChange?.(collector.snapshot());
	});

	const tickMs = options.tickMs ?? TICK_MS;
	const tick = tickMs > 0 ? setInterval(paint, tickMs) : undefined;
	tick?.unref?.();

	return {
		onEvent,
		collector,
		stop(exportDir, wallMs) {
			if (tick) clearInterval(tick);
			ui?.setStatus?.(STATUS, undefined);
			// The widget lives only while the work does: the summary is one line
			// up, in the tool row, and nothing should pile up above the prompt
			// between two requests.
			ui?.setWidget?.(STATUS, undefined);
			if (exportDir) writeRunReport(exportDir, collector.snapshot(), wallMs, options.mainSessionFile);
		},
	};
}

/**
 * Writes the artefacts only this level can write: `usage.json`, and the parent
 * session's JSONL when the caller knows where it is.
 *
 * Swallows its own failures - a full disk must not turn a finished workflow into
 * an error the model has to reason about.
 */
export function writeRunReport(dir: string, snapshot: TuiSnapshot, wallMs: number, mainSessionFile?: string): void {
	try {
		const main = mainSessionFile ? [copyMainSession(mainSessionFile, dir)] : undefined;
		writeUsageReport(dir, usageReport(snapshot, wallMs, main));
	} catch {
		// an export is an observer of the run, never a participant
	}
}

/**
 * Paints the dots that sit above the prompt.
 *
 * The lines themselves come from `widgetRows`, which knows nothing about
 * colour; this only applies the theme. Keeping the two apart is what lets the
 * layout be tested without a terminal.
 */
export function paintWidget(snapshot: TuiSnapshot, theme: WidgetTheme): string[] {
	return widgetRows(snapshot).map((row) => {
		if (row.kind === "detail") return `  ${theme.fg("dim", row.text)}`;

		const colour =
			row.status === "failed" ? "error" : row.status === "done" ? "success" : row.status === "blocked" ? "warning" : "accent";
		const dot = theme.fg(colour, row.icon);
		// The id carries the weight; the activity is deliberately quiet.
		return `${dot} ${theme.fg("toolTitle", row.id)}  ${theme.fg("muted", row.activity)}`;
	});
}

/**
 * The check a pipeline names, as a port. Absent means the pipeline names none.
 *
 * A pipeline *names* a command; running one is a decision that belongs to
 * whoever owns the working tree, which is why this lives beside the commands and
 * not inside the runner.
 */
export function pipelineVerifier(pipeline: Pipeline, cwd: string): Verify | undefined {
	const parts = pipeline.verify;
	if (!parts || parts.length === 0) return undefined;
	return commandVerifier({ cwd, command: parts[0] as string, args: parts.slice(1) });
}
