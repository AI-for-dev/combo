/**
 * What a run leaves behind: the transcripts and `usage.json` on disk, the
 * picture they are drawn from, and the matrix an experiment builds above them.
 *
 * Four files in a chain - `export.ts` writes a run directory, `measured.ts` is
 * the run that measures itself, `experiment.ts` repeats one over M models and
 * N times, `report.ts` reads the matrix back - and this is their door.
 * `exportSession` is on it for one caller, `spawn`, which is where a subagent's
 * transcript is still in hand.
 */

export { experiment, type ExperimentCell, type ExperimentOptions } from "./experiment.ts";
export {
	createRunDir,
	exportBaseName,
	exportSession,
	usageReport,
	writeUsageReport,
	type SessionExport,
	type UsageReport,
	type UsageReportEntry,
	type UsageTotal,
} from "./export.ts";
export { measuredRun, type MeasuredRun, type MeasuredRunOptions } from "./measured.ts";
export {
	experimentTable,
	type ExperimentModelSummary,
	type ExperimentOutcome,
	type ExperimentReport,
	type ExperimentRun,
} from "./report.ts";
