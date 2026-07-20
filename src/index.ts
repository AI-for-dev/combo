/**
 * Public surface of pi-subagent.
 *
 * Examples and the pi extension import from here, never from an internal file.
 */

export {
	findAgent,
	loadAgents,
	loadAgentsFromDir,
	parseAgent,
	type Agent,
	type AgentScope,
	type AgentSource,
	type Lifetime,
} from "./agent.ts";
export { scriptedAsk, type Answer, type AskUser, type Choice, type Question } from "./ask.ts";
export {
	branchName,
	commitAll,
	createBranch,
	currentBranch,
	diff,
	diffStat,
	isRepository,
	status,
	untracked,
	type GitResult,
} from "./git.ts";
export {
	copyMainSession,
	createRunDir,
	exportBaseName,
	exportSession,
	usageReport,
	writeUsageReport,
	type SessionExport,
	type UsageReport,
	type UsageReportEntry,
} from "./export.ts";
export {
	createEventBus,
	nextSubagentId,
	resetSubagentIds,
	type EventBus,
	type EventListener,
	type SubagentEvent,
	type SubagentStatus,
} from "./events.ts";
export {
	autoReporter,
	collapsedLine,
	combineReporters,
	consoleReporter,
	createHerdrReporter,
	createHerdrReporterWith,
	createHerdrSend,
	createTuiCollector,
	detectHerdr,
	formatToolCall,
	herdrAllFromEnv,
	HERDR_SOURCE,
	progressLine,
	silentReporter,
	currentActivity,
	detailLine,
	elapsedMs,
	statusIcon,
	summaryTable,
	widgetLines,
	widgetRows,
	type AutoReporterOptions,
	type ConsoleReporterOptions,
	type HerdrEnv,
	type HerdrOptions,
	type HerdrSend,
	type SubagentSnapshot,
	type ToolCall,
	type TuiCollector,
	type TuiSnapshot,
	type WidgetRow,
} from "./reporters/index.ts";
export { failed, type Result, type WorkflowResult } from "./result.ts";
export {
	BUILD_STATE_FILE,
	BUILD_STATE_VERSION,
	findResumableBuild,
	fromBuildState,
	loadBuildState,
	saveBuildState,
	toBuildState,
	type BuildProgress,
	type BuildState,
} from "./resume.ts";
export {
	parsePipeline,
	STEP_KINDS,
	type Pipeline,
	type PipelineStep,
	type StepKind,
} from "./pipeline.ts";
export { BUILTIN_AGENTS_DIR, BUILTIN_PIPELINES_DIR, PACKAGE_ROOT } from "./builtin.ts";
export {
	findPipeline,
	loadPipelines,
	loadPipelinesFromDir,
	PIPELINES_DIR,
	type BrokenPipeline,
	type PipelineCatalogue,
} from "./pipeline-load.ts";
export {
	checkPipelineAgents,
	runPipeline,
	stepInput,
	type PipelineRunOptions,
	type PipelineRunResult,
	type PipelineStepResult,
} from "./workflows/pipeline-run.ts";
export { run, type RunOptions } from "./run.ts";
export {
	createDefaultSession,
	READ_ONLY_TOOLS,
	StaticResourceLoader,
	type AgentMessage,
	type CreateSession,
	type CreateSessionOptions,
	type SessionPort,
} from "./session.ts";
export { spawn, type AskOptions, type SpawnOptions, type Subagent } from "./subagent.ts";
export { commandVerifier, type CommandVerifierOptions, type Verification, type Verify } from "./verify.ts";
export { compact, deltaUsage, emptyUsage, formatUsage, snapshotUsage, sumUsage, type Usage } from "./usage.ts";
export { chain, type ChainOptions } from "./workflows/chain.ts";
export {
	auditPrompt,
	AUDIT_APPROVAL,
	deliver,
	type AuditRound,
	type DeliverOptions,
	type DeliverResult,
} from "./workflows/deliver.ts";
export { mapConcurrent, SubagentPool, type SpawnFn, type WorkflowOptions } from "./workflows/common.ts";
export { aggregate, fanOut, type FanOutOptions, type FanOutResult } from "./workflows/fan-out.ts";
export { loop, type LoopOptions, type LoopResult, type UntilPredicate } from "./workflows/loop.ts";
export { orchestrate, type OrchestrateOptions, type OrchestrateResult } from "./workflows/orchestrate.ts";
export {
	makePlan,
	parsePlan,
	planningPrompt,
	type PlannedTask,
	type PlanOptions,
	type PlanOutcome,
} from "./workflows/plan.ts";
export {
	answerPrompt,
	briefPrompt,
	interview,
	parseQuestion,
	questionPrompt,
	READY,
	type InterviewOptions,
	type InterviewResult,
} from "./workflows/interview.ts";
export { APPROVAL, pair, remarksPrompt, reviewPrompt, type PairOptions, type PairResult } from "./workflows/pair.ts";
export { formatBranches, reduce, type ReduceOptions } from "./workflows/reduce.ts";
export { pickDestination, route, routingPrompt, type RouteOptions, type RouteResult } from "./workflows/route.ts";
