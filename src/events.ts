/**
 * The event stream: one core, many reporters.
 *
 * Display is an observer, never a participant. No workflow may depend on a UI
 * being there: unplug every reporter and the result is identical. Which is why
 * nothing here ever writes to the terminal.
 */

import type { Lifetime } from "./agent.ts";
import type { Post } from "./board.ts";
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
			/**
			 * Where this subagent came in the launch, counting from 1.
			 *
			 * The event cannot be emitted until the session exists, because it
			 * carries the model pi resolved - and sessions come up in whatever
			 * order they come up in. Measured: a fan-out of three drew as
			 * `scout#2, scout#1, scout#3`. A reader that wants the order the
			 * branches were launched in sorts on this.
			 */
			order: number;
			/**
			 * The subagent that had this one spawned, when one did.
			 *
			 * Absent at the top level, which is what makes a root a root. It
			 * travels on `spawn` alone: every later event about this subagent
			 * carries its `id`, and a reporter that saw the spawn already knows
			 * where to hang it. Sending it again would be a second copy of one
			 * fact, and two copies drift.
			 */
			parentId?: string;
	  }
	| {
			type: "status";
			id: string;
			status: SubagentStatus;
			/**
			 * The task this turn is about, on the `"working"` transition only.
			 *
			 * A reporter has no other way to learn it: `spawn` happens before
			 * anyone knows what the subagent will be asked, and a persistent
			 * subagent is asked several different things over its life.
			 */
			task?: string;
	  }
	| { type: "text"; id: string; delta: string }
	| { type: "tool"; id: string; name: string; args: unknown }
	/**
	 * A member said something on the board.
	 *
	 * `id` is the member, as on every other event; the post carries who it was
	 * for and what kind of thing it was. `record.ts` writes it down, which is
	 * what makes the traffic of a run readable afterwards instead of
	 * reconstructed, and the console reporter prints it as it happens.
	 */
	| { type: "post"; id: string; post: Post }
	/**
	 * A member was handed what it had not seen.
	 *
	 * The posts alone say who said what, and that is the smaller half: what an
	 * investigation asks is who *knew* what, and knowing comes from being handed
	 * something. Measured on three members dividing one job: the claims were
	 * spread over two seconds, so the later ones could have read the earlier,
	 * and nothing in the record could say whether they had.
	 *
	 * Only the ids: the text is already in the record, under the `post` that put
	 * it there. A read that was handed nothing is recorded too, and is the
	 * strongest thing the record holds about what a member could not have known.
	 */
	| { type: "read"; id: string; posts: readonly string[]; waiting: number }
	/**
	 * A member asked for a thing, or gave one back.
	 *
	 * `ok` is whether it got what it asked for, and `heldBy` names the holder
	 * when a take was refused. Recorded for the same reason a read is: the
	 * question afterwards is who held what and when, and a refusal is as much a
	 * fact of the run as a grant.
	 */
	| { type: "claim"; id: string; key: string; action: "take" | "release"; ok: boolean; heldBy?: string }
	| { type: "usage"; id: string; usage: Usage }
	| { type: "close"; id: string; result: Result };

/** A subscriber. Throwing from here must never break the workflow. */
export type EventListener = (event: SubagentEvent) => void;

/** The one channel between the core and every reporter. */
export type EventBus = {
	/** Delivers to every listener; a listener that throws is swallowed. */
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
let launched = 0;

/**
 * A stable id for a subagent, and where it came in the launch.
 *
 * The id is the key the TUI, herdr and the export use to follow one subagent
 * across its whole life. Counters are per-process and per-agent-name, which is
 * enough to read a fan-out of the same agent side by side.
 *
 * `order` counts every subagent of the process instead, and the two are handed
 * out together because they are one fact: the moment this subagent was asked
 * for. A second counter incremented somewhere else would drift from the id the
 * day one of the two calls moved.
 */
export function nextSubagentId(agentName: string): { id: string; order: number } {
	const n = (counters.get(agentName) ?? 0) + 1;
	counters.set(agentName, n);
	launched += 1;
	return { id: `${agentName}#${n}`, order: launched };
}

/** Resets the id counters. For tests that assert on exact ids. */
export function resetSubagentIds(): void {
	counters.clear();
	launched = 0;
}
