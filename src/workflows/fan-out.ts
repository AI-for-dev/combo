/**
 * `fanOut`: 1 → N. N subtasks in parallel, with bounded concurrency.
 */

import type { Agent } from "./../agent.ts";
import { failed, joinOutputs, succeeded, type Result, type WorkflowResult } from "./../result.ts";
import { sumUsage, type Usage } from "./../usage.ts";
import { mapConcurrent } from "./concurrent.ts";
import type { WorkflowOptions } from "./options.ts";
import { SubagentPool } from "./pool.ts";

/** The branches, who runs them, and how many may run at once. */
export type FanOutOptions = WorkflowOptions & {
	/** The agent running every branch, unless {@link FanOutOptions.agents} is given. */
	agent?: Agent;
	/** One agent per task, when branches use different agents. */
	agents?: Agent[];
	/** One task per branch. Their order is the order of the results. */
	tasks: string[];
	/** Maximum number of branches in flight. Defaults to 4. */
	concurrency?: number;
	/** Stop at the first failure instead of letting the other branches finish. */
	failFast?: boolean;
};

/**
 * The branches' results, and the fan-out read as one.
 *
 * As a `Result`: `output` is every branch's output labelled by its agent, a
 * failed one marked as such; `ok` is false when any branch failed and `error`
 * is the first failure's; `agent` and `messages` are that branch's, or the last
 * branch's when none failed. `usage.busyMs` is the sum of the branches and
 * `wallMs` the real duration: their ratio is the parallelism actually achieved.
 */
export type FanOutResult = WorkflowResult & {
	/** One result per task, **in the order of `tasks`** - not of completion. `steps` is this same list. */
	results: Result[];
};

/**
 * Runs N tasks in parallel.
 *
 * A branch failing is not a workflow failure: it becomes a `Result` with
 * `ok: false` in its slot, and the other branches carry on. Set `failFast` to
 * opt out of that.
 *
 * There is no shared mutable state between branches, whatever the lifetime. In
 * `"workflow"` lifetime each branch gets **its own** persistent subagent: two
 * branches never merge contexts. Working together means passing `Result`s
 * around, not sharing a memory.
 */
export async function fanOut(options: FanOutOptions): Promise<FanOutResult> {
	const { tasks, failFast } = options;
	const concurrency = Math.max(1, options.concurrency ?? 4);
	const agents = resolveAgents(options);

	const pool = new SubagentPool(options);
	let stopped = false;

	let results: Result[] = [];
	try {
		results = await mapConcurrent(tasks, concurrency, async (task, index) => {
			const agent = agents[index] as Agent;
			if (stopped) return failed(agent.name, "aborted");

			// Keyed by branch: even persistent, two branches stay isolated.
			const result = await pool.turn(agent, task, { key: `${agent.name}#${index}` });
			if (!result.ok && failFast) stopped = true;
			return result;
		});
	} finally {
		await pool.closeAll();
	}

	// The branch that speaks for the whole: the first that failed, else the
	// last. A fan-out of nothing is nobody's turn, and nothing went wrong in it.
	const pivot: Result = results.find((result) => !result.ok) ?? results.at(-1) ?? succeeded(options.agent?.name ?? "", "");
	return { ...pivot, output: joinOutputs(results), usage: pool.trail.usage(), steps: results, results };
}

/**
 * Sums the usage of several results over a real elapsed duration.
 *
 * Exported because a caller that fans out by hand needs the same arithmetic -
 * and because the ratio it produces is the number worth reading.
 */
export function aggregate(results: readonly Result[], wallMs: number): Usage {
	return sumUsage(
		results.map((result) => result.usage),
		wallMs,
	);
}

/** One agent per task: either the single `agent`, or the `agents` array. */
function resolveAgents(options: FanOutOptions): Agent[] {
	if (options.agents) {
		if (options.agents.length !== options.tasks.length) {
			throw new Error(`fanOut: ${options.agents.length} agents for ${options.tasks.length} tasks`);
		}
		return options.agents;
	}
	if (!options.agent) throw new Error("fanOut: `agent` or `agents` is required");
	return options.tasks.map(() => options.agent as Agent);
}
