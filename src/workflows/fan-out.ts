/**
 * `fanOut`: 1 → N. N subtasks in parallel, with bounded concurrency.
 */

import type { Agent } from "./../agent.ts";
import { failed, type Result } from "./../result.ts";
import { sumUsage, type Usage } from "./../usage.ts";
import { mapConcurrent, SubagentPool, type WorkflowOptions } from "./common.ts";

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

/** The branches' results, and what the parallelism actually was. */
export type FanOutResult = {
	/** One result per task, **in the order of `tasks`** - not of completion. */
	results: Result[];
	/**
	 * Aggregate usage. `busyMs` is the sum of the branches, `wallMs` the real
	 * duration: their ratio is the parallelism actually achieved.
	 */
	usage: Usage;
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
	const { tasks, signal, failFast, timeoutMs } = options;
	const concurrency = Math.max(1, options.concurrency ?? 4);
	const agents = resolveAgents(options);

	const pool = new SubagentPool(options);
	const startedAt = performance.now();
	let stopped = false;

	let results: Result[] = [];
	try {
		results = await mapConcurrent(tasks, concurrency, async (task, index) => {
			const agent = agents[index] as Agent;
			if (stopped || signal?.aborted) return failed(agent.name, "aborted");

			// Keyed by branch: even persistent, two branches stay isolated.
			const subagent = await pool.acquire(agent, `${agent.name}#${index}`);
			try {
				const result = await subagent.ask(task, { signal, timeoutMs });
				if (!result.ok && failFast) stopped = true;
				return result;
			} finally {
				await pool.release(subagent);
			}
		});
	} finally {
		await pool.closeAll();
	}

	return { results, usage: aggregate(results, performance.now() - startedAt) };
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
