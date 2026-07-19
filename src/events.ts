/**
 * The event stream: one core, many reporters.
 *
 * Display is an observer, never a participant. No workflow may depend on a UI
 * being there: unplug every reporter and the result is identical. Which is why
 * nothing here ever writes to the terminal.
 */

import type { Lifetime } from "./agent.ts";
import type { Result } from "./result.ts";
import type { Usage } from "./usage.ts";

/** What a subagent is doing right now, as seen from the outside. */
export type SubagentStatus = "working" | "idle" | "blocked" | "done";

/** Everything the core emits. Reporters subscribe, and only read. */
export type SubagentEvent =
	| {
			type: "spawn";
			id: string;
			agent: string;
			lifetime: Lifetime;
			/**
			 * Whether this subagent asked for its own herdr split.
			 *
			 * It travels on the event rather than being read back from the core,
			 * because a reporter is a pure observer: it never queries anything,
			 * it only listens.
			 */
			openInHerdr: boolean;
			/** `provider/id` as pi resolved it. Absent when pi could not say. */
			model?: string;
	  }
	| { type: "status"; id: string; status: SubagentStatus }
	| { type: "text"; id: string; delta: string }
	| { type: "tool"; id: string; name: string; args: unknown }
	| { type: "usage"; id: string; usage: Usage }
	| { type: "close"; id: string; result: Result };

/** A subscriber. Throwing from here must never break the workflow. */
export type EventListener = (event: SubagentEvent) => void;

export type EventBus = {
	emit(event: SubagentEvent): void;
	/** Returns the unsubscribe function. */
	subscribe(listener: EventListener): () => void;
};

/**
 * A minimal bus, no dependencies.
 *
 * A listener that throws is swallowed: a broken reporter must not take a
 * workflow down with it. That is the whole point of "an observer, never a
 * participant".
 */
export function createEventBus(): EventBus {
	const listeners = new Set<EventListener>();

	return {
		emit(event) {
			for (const listener of listeners) {
				try {
					listener(event);
				} catch {
					// a reporter's problem is never the workflow's problem
				}
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

const counters = new Map<string, number>();

/**
 * A stable id for a subagent: `reviewer#2`.
 *
 * It is the key used by the TUI, herdr and the export to follow one subagent
 * across its whole life. Counters are per-process and per-agent-name, which is
 * enough to read a fan-out of the same agent side by side.
 */
export function nextSubagentId(agentName: string): string {
	const n = (counters.get(agentName) ?? 0) + 1;
	counters.set(agentName, n);
	return `${agentName}#${n}`;
}

/** Resets the id counters. For tests that assert on exact ids. */
export function resetSubagentIds(): void {
	counters.clear();
}
