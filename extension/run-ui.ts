/**
 * What every command needs while subagents are working: the dots, the footer,
 * the transcripts.
 *
 * It exists because `/build` and `/run` must look **identical** while they run.
 * They had every reason to drift - two call sites, two timers, two ways of
 * clearing a widget - and the one that drifts is the one nobody is watching that
 * day. One painter, one `finally`, one report.
 */

import {
	combineReporters,
	commandVerifier,
	createHerdrReporter,
	createTuiCollector,
	usageReport,
	writeUsageReport,
	type EventListener,
	type Pipeline,
	type Verify,
} from "../src/index.ts";
import { paintWidget, watchEverything } from "./execute.ts";

/** Key for the footer status and the widget above the prompt. */
export const STATUS = "pi-subagent";

/** What a command needs from pi to show a run. A narrow slice, so a test can stand in. */
export type RunUi = {
	theme: Parameters<typeof paintWidget>[1];
	setStatus(key: string, text: string | undefined): void;
	setWidget?(key: string, lines: string[] | undefined): void;
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
	 * above the prompt for the rest of the session.
	 */
	stop(exportDir: string | undefined, wallMs: number): void;
};

/**
 * Starts painting a run.
 *
 * `tickMs` is a repaint period rather than a redraw on every event: `busyMs`
 * only lands when a turn ends, so a subagent thinking for twenty seconds emits
 * nothing at all, and a frozen clock reads as a hung agent. `0` disables the
 * timer, which is what tests want.
 */
export function liveRun(ui: RunUi, tickMs = 250): LiveRun {
	const collector = createTuiCollector();
	const onEvent = combineReporters(collector.reporter, createHerdrReporter({ all: watchEverything() }));

	const paint = () => ui.setWidget?.(STATUS, paintWidget(collector.snapshot(), ui.theme));
	collector.onChange(paint);
	const tick = tickMs > 0 ? setInterval(paint, tickMs) : undefined;
	tick?.unref?.();

	return {
		onEvent,
		collector,
		stop(exportDir, wallMs) {
			if (tick) clearInterval(tick);
			ui.setStatus(STATUS, undefined);
			ui.setWidget?.(STATUS, undefined);
			if (exportDir) writeRunReport(exportDir, collector, wallMs);
		},
	};
}

/** The one artefact we produce ourselves. Never lets an export take the run down. */
export function writeRunReport(dir: string, collector: ReturnType<typeof createTuiCollector>, wallMs: number): void {
	try {
		writeUsageReport(dir, usageReport(collector.snapshot(), wallMs));
	} catch {
		// an export is an observer of the run, never a participant
	}
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
