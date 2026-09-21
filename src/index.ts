/**
 * Public surface of combo.
 *
 * Examples and the pi extension import from here, never from an internal file.
 *
 * It is grouped the way it is learnt, not alphabetically: **the first section is
 * the whole library for most callers** - load an agent, run it, compose. Read on
 * only when you need what the section below it is for.
 *
 * Three rules decide whether a symbol belongs here at all. **A type named by a
 * public option or return value is public**, or the option cannot be used from
 * outside. **Test-only is a reason to stay off this list**: tests reach into
 * `src/` directly, so a helper exported for one is not part of the surface.
 * And **a value is public when somebody outside `src/` calls it**: the
 * extension, an example, a guide's code, or the TSDoc of a public option that
 * names it as the default a caller may wrap. A value nobody calls is a promise
 * nobody asked for, and this list is what a reader learns.
 */

// ── Start here: an agent, a run, a result ────────────────────────────────────

export {
	findAgent,
	LIFETIMES,
	loadAgents,
	loadAgentsFromDir,
	parseAgent,
	type Agent,
	type AgentScope,
	type AgentSource,
	type Lifetime,
} from "./agent.ts";
export { resolveSkills, type Skill, type SkillDir } from "./skills.ts";
export {
	IN_THE_LANGUAGE_OF_THE_WORK,
} from "./language.ts";
export { run, type RunOptions } from "./run.ts";
export { spawn, type AskOptions, type CustomToolsFor, type SpawnOptions, type Subagent } from "./subagent.ts";
export { stopSwitch, type StopSwitch, type StopSwitchOptions } from "./stop.ts";
export { failed, joinOutputs, succeeded, type JoinOptions, type Result, type WorkflowResult } from "./result.ts";
export { compact, deltaUsage, emptyUsage, formatUsage, sumUsage, type Usage } from "./usage.ts";

// ── The combinators, and the options every one of them shares ────────────────

export { mapConcurrent } from "./workflows/concurrent.ts";
export { offerBoth, type SpawnFn, type ToolOffer, type WorkflowOptions } from "./workflows/options.ts";
export { SubagentPool, type Held, type TurnOptions } from "./workflows/pool.ts";
export { Trail } from "./workflows/trail.ts";
export { chain, type ChainOptions } from "./workflows/chain.ts";
export { aggregate, fanOut, type FanOutOptions, type FanOutResult } from "./workflows/fan-out.ts";
export {
	swarm,
	task as swarmTask,
	type MemberSpec,
	type SwarmClaim,
	type SwarmEnd,
	type SwarmMember,
	type SwarmOptions,
	membersOutput,
	type SwarmResult,
} from "./workflows/swarm.ts";
export { loop, type LoopOptions, type LoopResult, type UntilPredicate } from "./workflows/loop.ts";
export { formatBranches, reduce, type ReduceOptions } from "./workflows/reduce.ts";
export { pickDestination, route, routingPrompt, type RouteOptions, type RouteResult } from "./workflows/route.ts";
export { orchestrate, type OrchestrateOptions, type OrchestrateResult } from "./workflows/orchestrate.ts";
export {
	parsePlan,
	planningPrompt,
	type PlannedTask,
	type PlanOptions,
	type PlanOutcome,
} from "./workflows/plan.ts";
export {
	APPROVAL,
	pair,
	type PairOptions,
	type PairResult,
} from "./workflows/deliver/index.ts";
export {
	interview,
	parseQuestion,
	READY,
	type InterviewOptions,
	type InterviewResult,
} from "./workflows/interview.ts";
export { deliver, type BuildProgress, type DeliverOptions, type DeliverResult } from "./workflows/deliver/index.ts";
export {
	audit,
	type AuditOptions,
	type AuditProgress,
	type AuditPromptOptions,
	type AuditResult,
	type AuditRound,
	type Fixed,
} from "./workflows/deliver/index.ts";

// ── Watching a run: reporters, and the picture they read ─────────────────────

export {
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
	createHerdrSend,
	createRunPicture,
	detectHerdr,
	probeHerdr,
	recordReporter,
	silentReporter,
	snapshotFrom,
	type AutoReporterOptions,
	type ConsoleReporterOptions,
	// `HerdrEnv` is what `detectHerdr` returns and `HerdrSend` is
	// `HerdrOptions.send`: both are named by a public signature.
	type HerdrEnv,
	type HerdrOptions,
	type HerdrSend,
	type RunPicture,
	type RunSnapshot,
	type SubagentSnapshot,
	type ToolCall,
} from "./reporters/index.ts";
// Formatting a snapshot. Drawing it is the caller's - see the pi extension,
// which is the only consumer of these today.
export {
	formatToolCall,
	progressLine,
	standingOf,
	statusColour,
	statusIcon,
	summaryTable,
	treeOrder,
	widgetRows,
	type WidgetRow,
} from "./reporters/index.ts";
export { head, plural, saysWord, tail, truncate } from "./text.ts";

// ── Measuring a run: transcripts on disk, and the matrix above them ──────────

export {
	createRunDir,
	exportBaseName,
	usageReport,
	writeUsageReport,
	type SessionExport,
	type UsageReport,
	type UsageReportEntry,
	type UsageTotal,
} from "./export.ts";
export { measuredRun, type MeasuredRun, type MeasuredRunOptions } from "./measured.ts";
export {
	experiment,
	type ExperimentCell,
	type ExperimentOptions,
	type ExperimentOutcome,
} from "./experiment.ts";
export {
	experimentTable,
	type ExperimentModelSummary,
	type ExperimentReport,
	type ExperimentRun,
} from "./experiment-report.ts";

// ── Pipelines: a workflow written down, found, and run ───────────────────────

export {
	parsePipeline,
	type Pipeline,
	type PipelineStep,
	type StepKind,
} from "./pipeline.ts";
export {
	findPipeline,
	loadPipelines,
	lookupPipeline,
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
	diff,
	diffStat,
	isRepository,
	status,
	untracked,
	type GitResult,
} from "./git.ts";
export { type Scratch } from "./scratch.ts";
export { land, type Landed, type Landing } from "./land.ts";
export { type Settling, type SettleOptions } from "./workflows/deliver/index.ts";
export {
	declaresDelegate,
	delegateTool,
	MAX_DEPTH,
	type DelegateOptions,
} from "./delegate.ts";
export {
	createWorktree,
	listWorktrees,
	removeWorktree,
	worktreePatch,
	type CreateWorktreeOptions,
	type Worktree,
} from "./worktree.ts";
export { commandVerifier, type CommandVerifierOptions, type Verification, type Verify } from "./verify.ts";
export { type ProseApproval, type ReviewRecord, type ReviewRecordOptions, type ReviewRound } from "./review.ts";
export {
	type Resolution,
	type Verdict,
	type VerdictTool,
} from "./verdict.ts";
export {
	type Closure,
	type CloseOutcome,
	type Ledger,
	type Obligation,
} from "./ledger.ts";

export { declaresBoard, type BoardToolOptions } from "./board-tool.ts";
export { declares, refuse, said } from "./tool.ts";
export {
	createClaims,
	heldList,
	type Claims,
	type ClaimsOptions,
	type Holding,
	type TakeOutcome,
} from "./claims.ts";
export {
	boardLines,
	createBoard,
	type Board,
	type BoardLimits,
	type BoardOptions,
	type Draft,
	type Post,
	type PostKind,
	type PostOutcome,
	type Reading,
} from "./board.ts";
export { agreed, VOTE_INSTRUCTION } from "./agreement.ts";
export { type Answer, type AskUser, type Choice, type Question } from "./ask.ts";
export {
	BUILD_STATE_VERSION,
	findResumableBuild,
	fromBuildState,
	missingAgents,
	saveBuildState,
	toBuildState,
	type BuildState,
} from "./workflows/deliver/index.ts";

// ── Reaching a live subagent from outside: the mirror a pane attaches to ─────

export {
	type Attach,
	type MirrorIn,
	type MirrorOut,
	type Mirrored,
} from "./mirror.ts";

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
	type ToolDefinition,
} from "./session.ts";
