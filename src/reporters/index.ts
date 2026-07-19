/**
 * Choosing a reporter, so the caller does not have to.
 *
 * Requirement 3 of the project: you watch subagents work in herdr if it is
 * running, in pi's TUI otherwise, **without changing a line of calling code**.
 * That promise is this one function.
 */

import type { EventListener } from "../events.ts";
import { createHerdrReporter, type HerdrOptions } from "./herdr.ts";
import { silentReporter } from "./silent.ts";

export { consoleReporter, type ConsoleReporterOptions } from "./console.ts";
export { createHerdrReporter, createHerdrReporterWith, type HerdrOptions } from "./herdr.ts";
export { createHerdrSend, detectHerdr, HERDR_SOURCE, type HerdrEnv, type HerdrSend } from "./herdr-client.ts";
export { silentReporter } from "./silent.ts";
export {
	collapsedLine,
	createTuiCollector,
	formatToolCall,
	progressLine,
	statusIcon,
	summaryTable,
	type SubagentSnapshot,
	type ToolCall,
	type TuiCollector,
	type TuiSnapshot,
} from "./tui.ts";

export type AutoReporterOptions = HerdrOptions & {
	/** Used when herdr is absent. Defaults to {@link silentReporter}. */
	fallback?: EventListener;
};

/**
 * The herdr reporter when we are inside herdr, the fallback otherwise.
 *
 * Never throws, never warns: not running under herdr is the normal case, not a
 * degraded one.
 */
export function autoReporter(options: AutoReporterOptions = {}): EventListener {
	const { fallback = silentReporter, ...herdr } = options;
	return createHerdrReporter(herdr) ?? fallback;
}
