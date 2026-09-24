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
	type MemberSpec,
	type SwarmClaim,
	type SwarmEnd,
	type SwarmMember,
	type SwarmOptions,
	membersOutput,
	type SwarmResult,
} from "./workflows/swarm.ts";
export { swarmTask } from "./workflows/swarm-task.ts";
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
	interview,
	parseQuestion,
	READY,
	type InterviewOptions,
	type InterviewResult,
} from "./workflows/interview.ts";

// ── Watching a run: reporters, and the picture they read ─────────────────────

export {
	isVisit,
	type EventBus,
	type EventListener,
	type SubagentEvent,
	type SubagentStatus,
	type VisitEvent,
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
	callLine,
	currentActivity,
	detailLine,
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
	experiment,
	experimentTable,
	exportBaseName,
	measuredRun,
	usageReport,
	writeUsageReport,
	type ExperimentCell,
	type ExperimentModelSummary,
	type ExperimentOptions,
	type ExperimentOutcome,
	type ExperimentReport,
	type ExperimentRun,
	type MeasuredRun,
	type MeasuredRunOptions,
	type SessionExport,
	type UsageReport,
	type UsageReportEntry,
	type UsageTotal,
} from "./measure/index.ts";

// ── Flows: a task graph written down, checked whole, then run ────────────────

// Finding a flow, and the two stages that check it before its first spawn.
export {
	checkFlow,
	checkRun,
	loadFlowCatalogue,
	removedPipelines,
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
	type CheckedRun,
	type CheckFlow,
	type CheckRun,
	type Condition,
	type ErrorKind,
	type Fault,
	type FaultCode,
	type Field,
	type FlowCatalogue,
	type FlowError,
	type FlowPorts,
	type FoundFlow,
	type NamedAgent,
	type RemovedPipeline,
	type RunStage,
	type Sources,
	type ValueType,
} from "./flow/index.ts";
// The ports a run reaches the world through. `AskUser`, the third, is with the questions below.
export { bashCheck, type CheckScript, type ScriptOutcome, type ScriptRequest } from "./verify.ts";
export { gitPort, type GitPort } from "./git/index.ts";
// Running a checked flow, for real or on scripted answers, and carrying on one that stopped.
export {
	dryRunFlow,
	latestResumable,
	parseDuration,
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
} from "./flow/index.ts";
// Drawing one: its worst case, its plan, its diagram, and its plan filled as a run goes.
export {
	livePlan,
	liveRows,
	mermaidOf,
	planOf,
	showBound,
	showLive,
	showPlan,
	showSummary,
	type Bound,
	type Bounds,
	type LiveLine,
	type LivePlan,
	type LiveRow,
	type LiveState,
	type LiveSummary,
	type Plan,
	type PlanLine,
} from "./flow/index.ts";

// ── The ports that touch the world: git, a question, a board ─────────────────

export {
	branchName,
	commitAll,
	createBranch,
	createWorktree,
	diff,
	diffStat,
	isRepository,
	land,
	listWorktrees,
	removeWorktree,
	scratchWorktree,
	status,
	untracked,
	worktreePatch,
	type CreateWorktreeOptions,
	type GitResult,
	type Landed,
	type Landing,
	type Scratch,
	type Worktree,
} from "./git/index.ts";
export {
	declaresDelegate,
	delegateTool,
	MAX_DEPTH,
	type DelegateOptions,
} from "./delegate.ts";
// What a flow's journal records of a review: an obligation, and how it closed.
export { type Closure, type Obligation } from "./review/index.ts";

export { declaresBoard, type BoardToolOptions } from "./board/index.ts";
export { declares, refuse, said } from "./tool.ts";
export {
	createClaims,
	heldList,
	type Claims,
	type ClaimsOptions,
	type Holding,
	type TakeOutcome,
} from "./board/index.ts";
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
} from "./board/index.ts";
export { agreed, latestVotes, VOTE_INSTRUCTION } from "./board/index.ts";
export { type Answer, type Asking, type AskUser, type Choice, type Question, type Shown } from "./ask.ts";

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
	type MainSession,
	type SessionPort,
	type ToolDefinition,
} from "./session.ts";
