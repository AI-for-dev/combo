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
	LIFETIMES,
	loadAgents,
	loadAgentsFromDir,
	parseAgent,
	type Agent,
	type AgentScope,
	type AgentSource,
	type Lifetime,
} from "./agent.ts";
export { resolveSkills, skillDirs, type Skill, type SkillDir } from "./skills.ts";
export {
	answerInTheirLanguage,
	ANSWER_IN_THEIR_LANGUAGE,
	inTheLanguageOfTheWork,
	IN_THE_LANGUAGE_OF_THE_WORK,
} from "./language.ts";
export { run, type RunOptions } from "./run.ts";
export { spawn, type AskOptions, type CustomToolsFor, type SpawnOptions, type Subagent } from "./subagent.ts";
export { stopSwitch, type StopSwitch, type StopSwitchOptions } from "./stop.ts";
export { abortError, failed, joinOutputs, succeeded, type JoinOptions, type Result, type WorkflowResult } from "./result.ts";
export { accumulate, compact, deltaUsage, emptyUsage, formatUsage, snapshotUsage, sumUsage, type Usage } from "./usage.ts";

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
	makePlan,
	parsePlan,
	planningPrompt,
	type PlannedTask,
	type PlanOptions,
	type PlanOutcome,
} from "./workflows/plan.ts";
export {
	APPROVAL,
	pair,
	remarksPrompt,
	type PairOptions,
	type PairResult,
} from "./workflows/pair.ts";
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
export { deliver, type BuildProgress, type DeliverOptions, type DeliverResult } from "./workflows/deliver.ts";
export {
	audit,
	auditPrompt,
	AUDIT_APPROVAL,
	type AuditOptions,
	type AuditProgress,
	type AuditPromptOptions,
	type AuditResult,
	type AuditRound,
	type Fixed,
} from "./workflows/audit.ts";

// ── Watching a run: reporters, and the picture they read ─────────────────────

export {
	busFor,
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
	copyMainSession,
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
	lookupPipeline,
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
	applyPatch,
	branchName,
	commitAll,
	createBranch,
	currentBranch,
	diff,
	diffStat,
	headSha,
	isRepository,
	status,
	untracked,
	type GitResult,
} from "./git.ts";
export { scratchWorktree, type Scratch } from "./scratch.ts";
export { land, landable, type Landed, type Landing } from "./land.ts";
export { settling, type Settling, type SettleOptions } from "./workflows/settle.ts";
export {
	declaresDelegate,
	delegateTool,
	MAX_DEPTH,
	SUBAGENT_TOOL,
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
export { reviewRecord, type ProseApproval, type ReviewRecord, type ReviewRecordOptions, type ReviewRound } from "./review.ts";
export {
	declaresVerdict,
	VERDICT_TOOL,
	verdictTool,
	type Resolution,
	type Verdict,
	type VerdictTool,
} from "./verdict.ts";
export {
	createLedger,
	openList,
	type Closure,
	type CloseOutcome,
	type Ledger,
	type Obligation,
} from "./ledger.ts";
export { announcedBoard, announcedClaims } from "./announced.ts";
export { boardTool, declaresBoard, BOARD_TOOL, type BoardToolOptions } from "./board-tool.ts";
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
export { agreed, latestVotes, VOTE_INSTRUCTION } from "./agreement.ts";
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
	type BuildState,
} from "./resume.ts";

// ── Reaching a live subagent from outside: the mirror a pane attaches to ─────

export {
	mirrorSocket,
	REFUSED_IDLE,
	registerMirror,
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
