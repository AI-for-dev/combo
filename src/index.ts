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
	statusIcon,
	summaryTable,
	type AutoReporterOptions,
	type ConsoleReporterOptions,
	type HerdrEnv,
	type HerdrOptions,
	type HerdrSend,
	type SubagentSnapshot,
	type ToolCall,
	type TuiCollector,
	type TuiSnapshot,
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
export { deltaUsage, emptyUsage, formatUsage, snapshotUsage, sumUsage, type Usage } from "./usage.ts";
export { chain, type ChainOptions } from "./workflows/chain.ts";
export { SubagentPool, type SpawnFn, type WorkflowOptions } from "./workflows/common.ts";
export { aggregate, fanOut, type FanOutOptions, type FanOutResult } from "./workflows/fan-out.ts";
export { loop, type LoopOptions, type LoopResult, type UntilPredicate } from "./workflows/loop.ts";
