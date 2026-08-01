/**
 * Public surface of combo.
 *
 * Examples and the pi extension import from here, never from an internal file.
 *
 * It is grouped the way it is learnt, not alphabetically: **the first section is
 * the whole library for most callers** - load an agent, run it, compose. Read on
 * only when you need what the section below it is for.
 *
 * Two rules decide whether a symbol belongs here at all. **A type named by a
 * public option or return value is public**, or the option cannot be used from
 * outside. And **test-only is a reason to stay off this list**: tests reach into
 * `src/` directly, so a helper exported for one is not part of the surface.
 */

// ── Start here: an agent, a run, a result ────────────────────────────────────

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
export { run, type RunOptions } from "./run.ts";
export { spawn, type AskOptions, type SpawnOptions, type Subagent } from "./subagent.ts";
export { failed, type Result, type WorkflowResult } from "./result.ts";
export { compact, deltaUsage, emptyUsage, formatUsage, snapshotUsage, sumUsage, type Usage } from "./usage.ts";

// ── The combinators, and the options every one of them shares ────────────────

export { mapConcurrent, SubagentPool, type SpawnFn, type WorkflowOptions } from "./workflows/common.ts";
export { chain, type ChainOptions } from "./workflows/chain.ts";
export { aggregate, fanOut, type FanOutOptions, type FanOutResult } from "./workflows/fan-out.ts";
export { loop, type LoopOptions, type LoopResult, type UntilPredicate } from "./workflows/loop.ts";
export { formatBranches, reduce, type ReduceOptions } from "./workflows/reduce.ts";
export { pickDestination, route, routingPrompt, type RouteOptions, type RouteResult } from "./workflows/route.ts";
export { orchestrate, type OrchestrateOptions, type OrchestrateResult } from "./workflows/orchestrate.ts";
export {
	makePlan,
	parsePlan,
	planningPrompt,
	type PlannedTask,
	type PlanOptions,
	type PlanOutcome,
} from "./workflows/plan.ts";
export { APPROVAL, pair, remarksPrompt, reviewPrompt, type PairOptions, type PairResult } from "./workflows/pair.ts";
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
export {
	auditPrompt,
	AUDIT_APPROVAL,
	deliver,
	type AuditRound,
	type DeliverOptions,
	type DeliverResult,
} from "./workflows/deliver.ts";

// ── Watching a run: reporters, and the state they collect ────────────────────

export {
	createEventBus,
	type EventBus,
	type EventListener,
	type SubagentEvent,
	type SubagentStatus,
} from "./events.ts";
export {
	autoReporter,
	combineReporters,
	consoleReporter,
	createHerdrReporter,
	createHerdrReporterWith,
	createTuiCollector,
	detectHerdr,
	recordReporter,
	silentReporter,
	type AutoReporterOptions,
	type ConsoleReporterOptions,
	// `HerdrEnv` is what `detectHerdr` returns and `HerdrSend` is
	// `HerdrOptions.send`: both are named by a public signature.
	type HerdrEnv,
	type HerdrOptions,
	type HerdrSend,
	type SubagentSnapshot,
	type ToolCall,
	type TuiCollector,
	type TuiSnapshot,
} from "./reporters/index.ts";
// Formatting a collected snapshot. Drawing it is the caller's - see the pi
// extension, which is the only consumer of these today.
export {
	collapsedLine,
	formatToolCall,
	progressLine,
	statusIcon,
	summaryTable,
	widgetRows,
	type WidgetRow,
} from "./reporters/index.ts";
export { truncate } from "./text.ts";

// ── Measuring a run: transcripts on disk, and the matrix above them ──────────

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
	experiment,
	type ExperimentCell,
	type ExperimentOptions,
	type ExperimentOutcome,
} from "./experiment.ts";
export {
	experimentReport,
	experimentTable,
	writeExperimentReport,
	type ExperimentModelSummary,
	type ExperimentReport,
	type ExperimentRun,
} from "./experiment-report.ts";

// ── Pipelines: a workflow written down, found, and run ───────────────────────

export {
	parsePipeline,
	STEP_KINDS,
	type Pipeline,
	type PipelineStep,
	type StepKind,
} from "./pipeline.ts";
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

// ── The ports that touch the world: git, a check, a question, a saved build ──

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
export { commandVerifier, type CommandVerifierOptions, type Verification, type Verify } from "./verify.ts";
export { scriptedAsk, type Answer, type AskUser, type Choice, type Question } from "./ask.ts";
export {
	BUILD_STATE_FILE,
	BUILD_STATE_VERSION,
	findResumableBuild,
	fromBuildState,
	loadBuildState,
	missingAgents,
	saveBuildState,
	toBuildState,
	type BuildProgress,
	type BuildState,
} from "./resume.ts";

// ── The pi session itself: the seam every test injects a fake into ───────────

export {
	checkModel,
	// The default factory, and the two types `SpawnOptions.createSession` is
	// written in: wrapping it is how a caller reaches pi's session themselves.
	createDefaultSession,
	READ_ONLY_TOOLS,
	situate,
	StaticResourceLoader,
	type AgentMessage,
	type CreateSession,
	type CreateSessionOptions,
	type SessionPort,
} from "./session.ts";
