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
export { createHerdrReporter, createHerdrReporterWith, herdrAllFromEnv, type HerdrOptions } from "./herdr.ts";
export { createHerdrSend, detectHerdr, HERDR_SOURCE, type HerdrEnv, type HerdrSend } from "./herdr-client.ts";
export { silentReporter } from "./silent.ts";
export {
	collapsedLine,
	createTuiCollector,
	formatToolCall,
	progressLine,
	currentActivity,
	detailLine,
	elapsedMs,
	statusIcon,
	summaryTable,
	widgetLines,
	widgetRows,
	type SubagentSnapshot,
	type ToolCall,
	type TuiCollector,
	type TuiSnapshot,
	type WidgetRow,
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

/**
 * Feeds one event stream to several reporters.
 *
 * `onEvent` takes a single listener, so watching in two places at once - the pi
 * TUI *and* herdr - needs composing. Absent entries are dropped, which is what
 * makes `combineReporters(collector, createHerdrReporter())` read well:
 * `createHerdrReporter` returns `undefined` outside herdr.
 *
 * One reporter throwing does not stop the others; that guarantee belongs to the
 * bus, and this keeps it when there is no bus in between.
 */
export function combineReporters(...reporters: (EventListener | undefined)[]): EventListener {
	const active = reporters.filter((reporter): reporter is EventListener => reporter !== undefined);
	if (active.length === 1) return active[0] as EventListener;

	return (event) => {
		for (const reporter of active) {
			try {
				reporter(event);
			} catch {
				// an observer's failure is never the workflow's
			}
		}
	};
}
