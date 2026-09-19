/**
 * The stop switch of a live run: everything at once, or one subagent of it.
 *
 * A workflow already honours a `signal` - that is how a whole run is called
 * off. What it has no way of expressing is *this branch, not the others*: the
 * signal is shared by every subagent under it, and a combinator hands out no
 * handles. So the switch sits where the handles pass: it wraps `spawn`, keeps
 * what came out of it by id, and hands the workflow the signal it will obey.
 *
 * Both halves are ports, not globals: a script builds one, gives its `signal`
 * and its `spawn` to the workflow, and stops whatever it likes from outside.
 * The extension is the first caller, not the only possible one.
 */

import { spawn as defaultSpawn, type Subagent } from "./subagent.ts";
import type { SpawnFn } from "./workflows/common.ts";

/** What a caller varies. Both default to the real thing. */
export type StopSwitchOptions = {
	/** An outer signal. Aborting it stops the run, exactly as {@link StopSwitch.all} does. */
	signal?: AbortSignal;
	/** The `spawn` to wrap. Defaults to the real one. */
	spawn?: SpawnFn;
};

/** A live run's two halves: what it obeys, and what stops it. */
export type StopSwitch = {
	/**
	 * Give this to the workflow as its `signal`.
	 *
	 * It aborts when {@link StopSwitch.all} is called, and when the outer signal
	 * does.
	 */
	readonly signal: AbortSignal;
	/**
	 * Give this to the workflow as its `spawn`.
	 *
	 * The subagents it produces are registered on the way out, which is what
	 * makes {@link StopSwitch.one} possible at all. Delegated children arrive
	 * here too, as long as the workflow passes the same `spawn` down.
	 */
	readonly spawn: SpawnFn;
	/** Stops one subagent. `false` when no subagent of that id came through here. */
	one(id: string): boolean;
	/** Stops the run: the turns in flight, and the ones it was about to start. */
	all(): void;
};

/**
 * Builds the stop switch for one run.
 *
 * Stopping is one-way: a stopped subagent stays stopped, and a stopped run
 * refuses the turns the workflow has not started yet. Nothing here closes
 * anything - whoever opened a subagent still closes it, on this path like on
 * any other, which is what keeps an interrupted run exportable.
 */
export function stopSwitch(options: StopSwitchOptions = {}): StopSwitch {
	const controller = new AbortController();
	const outer = options.signal;
	if (outer?.aborted) controller.abort();
	else outer?.addEventListener("abort", () => controller.abort(), { once: true });

	const spawnFn = options.spawn ?? defaultSpawn;
	const subagents = new Map<string, Subagent>();

	return {
		signal: controller.signal,

		async spawn(agent, spawnOptions) {
			const subagent = await spawnFn(agent, spawnOptions);
			subagents.set(subagent.id, subagent);
			return subagent;
		},

		one(id) {
			const subagent = subagents.get(id);
			subagent?.stop();
			return subagent !== undefined;
		},

		all() {
			controller.abort();
			// Both halves are needed: the signal is what stops the turns the
			// workflow had not started yet, and `stop()` is what tells each
			// subagent it was stopped rather than caught by a run that ended.
			for (const subagent of subagents.values()) subagent.stop();
		},
	};
}
