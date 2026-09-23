/**
 * What a run leaves behind: the transcripts and `usage.json` on disk, the
 * picture they are drawn from, and the matrix an experiment builds above them.
 *
 * Four files in a chain - `export.ts` writes a run directory, `measured.ts` is
 * the run that measures itself, `experiment.ts` repeats one over M models and
 * N times, `report.ts` reads the matrix back - and this is their door. A flow
 * run adds its visits and its lives (`flow-usage.ts`), read from its journal
 * (`lives.ts`), which the live view reads too.
 * `exportSession` is on it for one caller, `spawn`, which is where a subagent's
 * transcript is still in hand.
 */

export { experiment, type ExperimentCell, type ExperimentOptions } from "./experiment.ts";
export {
	createRunDir,
	exportBaseName,
	exportSession,
	freeName,
	newestRunFirst,
	usageReport,
	writeUsageReport,
	type LifeUsage,
	type NodeUsage,
	type SessionExport,
	type UsageReport,
	type UsageReportEntry,
	type UsageTotal,
	type VisitUsage,
} from "./export.ts";
export { costOf, livesOf, type JournalLife } from "./lives.ts";
export { measuredRun, type MeasuredRun, type MeasuredRunOptions } from "./measured.ts";
export {
	experimentTable,
	type ExperimentModelSummary,
	type ExperimentOutcome,
	type ExperimentReport,
	type ExperimentRun,
} from "./report.ts";
