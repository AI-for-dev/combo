/**
 * A flow: a task graph written in YAML + Markdown, from a closed set of nodes,
 * validated whole before the first spawn and walked by our runner.
 *
 * This is the module's door. Nothing outside the library reaches it yet: the
 * format is built beside the linear pipeline, and the package exports it when
 * it replaces that. The file's reader, its nodes and its sections are
 * implementation: `loadFlowCatalogue` finds what a flow runs against,
 * `checkFlow` is how a flow is read, `checkRun` holds it to the project it is
 * launched in, and `runFlow` and `dryRunFlow` are how a checked one runs.
 * `readSnapshot` and `readJournal` read back what a run left in its run
 * directory, `resumePoint` says where it picks up, and `resumeFlow` resumes it.
 */

export { loadFlowCatalogue, type FlowCatalogue } from "./catalogue.ts";
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
	ANSWER_CODES,
	dryRunFlow,
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
