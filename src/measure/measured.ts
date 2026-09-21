/**
 * A run that measures itself: the picture it is drawn from, the stream it may
 * keep, and the `usage.json` it leaves behind.
 *
 * Two places assembled this by hand - the extension's live view and an
 * experiment's cell - each with its own picture, its own composition of
 * listeners, its own clock and its own write of the report. Two adapters at
 * one seam, and the seam had no name. It has one now, and both stand on it:
 * the view adds a terminal on top, the cell a recorder beside.
 */

import path from "node:path";
import type { EventListener } from "../events.ts";
import { copyMainSession, usageReport, writeUsageReport, type UsageReport } from "./export.ts";
import { combineReporters, createRunPicture, recordReporter, type RunPicture } from "../reporters/index.ts";

/** What a measured run may vary. Everything else is the same everywhere. */
export type MeasuredRunOptions = {
	/** Where `usage.json` lands when the run is over, and the stream if kept. Absent writes nothing. */
	dir?: string;
	/** Keep the whole event stream on disk as `events.jsonl` beside `usage.json`. Needs `dir`. */
	record?: boolean;
	/** Other listeners on the same stream, after the picture: a terminal, a herdr pane, a caller's own. */
	listeners?: readonly (EventListener | undefined)[];
	/**
	 * The parent session's JSONL, copied in beside the subagents' transcripts.
	 *
	 * An export that lost the parent would be half a story, and only the caller
	 * that has the session knows where it is.
	 */
	mainSessionFile?: string;
};

/** A run being measured, and the one call that closes the measurement. */
export type MeasuredRun = {
	/** Subscribe this to the workflow: the picture, the recorder and the listeners, composed. */
	onEvent: EventListener;
	/** The state a view is drawn from, and the report is built from. */
	picture: RunPicture;
	/** How long the run has been measured. Its wall time, measured once, here. */
	elapsedMs(): number;
	/**
	 * Closes the measurement: writes `usage.json` into `dir` with the time
	 * measured, the parent session copied in when one was named, and hands the
	 * report back.
	 *
	 * Never throws. An export is an observer of the run, and a full disk must not
	 * turn a finished workflow into an error the caller has to reason about.
	 */
	finish(): UsageReport;
};

/** Opens a measurement. The clock starts here. */
export function measuredRun(options: MeasuredRunOptions = {}): MeasuredRun {
	const startedAt = performance.now();
	const picture = createRunPicture();
	const recorder = options.record && options.dir ? recordReporter(path.join(options.dir, "events.jsonl")) : undefined;
	const elapsedMs = () => performance.now() - startedAt;

	return {
		onEvent: combineReporters(picture.reporter, recorder, ...(options.listeners ?? [])),
		picture,
		elapsedMs,
		finish() {
			const { dir } = options;
			const main = dir && options.mainSessionFile ? [copyMainSession(options.mainSessionFile, dir)] : undefined;
			const report = usageReport(picture.snapshot(), elapsedMs(), main);
			if (dir) {
				try {
					writeUsageReport(dir, report);
				} catch {
					// an export is an observer of the run, never a participant
				}
			}
			return report;
		},
	};
}
