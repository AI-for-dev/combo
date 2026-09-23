/**
 * A flow: a task graph written in YAML + Markdown, from a closed set of nodes,
 * validated whole before the first spawn and walked by our runner.
 *
 * This is the module's door, and `src/index.ts` exports from it what a caller
 * outside the library calls. The file's reader, its nodes and its sections are
 * implementation: `loadFlowCatalogue` finds what a flow runs against,
 * `removedPipelines` refuses what is left of the linear format,
 * `checkFlow` is how a flow is read, `checkRun` holds it to the project it is
 * launched in, and `runFlow` and `dryRunFlow` are how a checked one runs.
 * `readSnapshot` and `readJournal` read back what a run left in its run
 * directory, `resumePoint` says where it picks up, `resumeFlow` resumes it,
 * and `latestResumable` finds the newest run a resume would take.
 * `planOf` and `mermaidOf` render a checked flow, whose `bounds` say its
 * worst case, and `livePlan` fills its plan as a run goes, which `showLive`
 * writes and `liveRows` hands to a caller that draws it its own way.
 */

export { showBound, type Bound, type Bounds } from "./bounds.ts";
export { loadFlowCatalogue, removedPipelines, type FlowCatalogue, type FoundFlow, type RemovedPipeline } from "./catalogue.ts";
export { checkFlow, type CheckFlow } from "./check.ts";
export { checkRun, type CheckRun, type CheckedRun, type FlowPorts, type RunStage } from "./check-run.ts";
export {
	CHECK,
	ERROR_KINDS,
	LEDGER,
	STOPS,
	VERDICT,
	type CheckedAgentNode,
	type CheckedAskNode,
	type CheckedCallNode,
	type CheckedCheckNode,
	type CheckedChoiceNode,
	type CheckedFlow,
	type CheckedLoopNode,
	type CheckedMapNode,
	type CheckedNode,
	type CheckedParallelNode,
	type CheckedRead,
	type ErrorKind,
	type FlowError,
} from "./checked.ts";
export {
	CONDITION_CODES,
	compileCondition,
	evaluateCondition,
	type Compiled,
	type Condition,
	type ConditionCode,
	type ConditionProblem,
	type Evaluated,
	type Readable,
} from "./condition/index.ts";
export { FAULT_CODES, type Fault, type FaultCode } from "./fault.ts";
export {
	livePlan,
	liveRows,
	mermaidOf,
	planOf,
	showLive,
	showPlan,
	showSummary,
	type LiveLine,
	type LivePlan,
	type LiveRow,
	type LiveState,
	type LiveSummary,
	type Plan,
	type PlanLine,
} from "./render/index.ts";
export {
	ANSWER_CODES,
	dryRunFlow,
	latestResumable,
	readJournal,
	readSnapshot,
	resumeFlow,
	resumePoint,
	runFlow,
	type AnswerFault,
	type Answers,
	type DryRun,
	type DryRunOptions,
	type FlowResult,
	type JournalEntry,
	type Resumable,
	type Resumed,
	type ResumeFlowOptions,
	type ResumePoint,
	type RunFlowOptions,
	type Settings,
	type Snapshot,
	type VisitEnd,
} from "./run/index.ts";
export type { NamedAgent, Sources } from "./sources.ts";
export { QUESTION, readSchema, type ReadSchema, type SchemaProblem } from "./schema.ts";
export { showType, type Field, type ValueType } from "./type.ts";
export { parseDuration } from "./value.ts";
