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
export { compact, deltaUsage, emptyUsage, formatUsage, snapshotUsage, sumUsage, type Usage } from "./usage.ts";
export { chain, type ChainOptions } from "./workflows/chain.ts";
export { SubagentPool, type SpawnFn, type WorkflowOptions } from "./workflows/common.ts";
export { aggregate, fanOut, type FanOutOptions, type FanOutResult } from "./workflows/fan-out.ts";
export { loop, type LoopOptions, type LoopResult, type UntilPredicate } from "./workflows/loop.ts";
export { formatBranches, reduce, type ReduceOptions } from "./workflows/reduce.ts";
