/**
 * `loop`: 1 → 1, repeated until a criterion is met.
 *
 * The coding ↔ review loop is the reason this library exists. It is also where
 * lifetime stops being a detail: the same two agents, iterated five times,
 * behave like a team that remembers or like five independent pairs of eyes.
 */

import type { Agent } from "./../agent.ts";
import { failed, type Result, type WorkflowResult } from "./../result.ts";
import { SubagentPool, type WorkflowOptions } from "./common.ts";

/**
 * Decides whether the loop is done, from the last step's result.
 *
 * May be async: the judge is often a test run or a build, not a regex.
 */
export type UntilPredicate = (result: Result, iteration: number) => boolean | Promise<boolean>;

/** The cycle: what runs, on what, and the two guards that end it. */
export type LoopOptions = WorkflowOptions & {
	/** Agents run in order, once per iteration. Output flows from one to the next. */
	steps: Agent[];
	/** Task given to the first step of the first iteration. */
	input: string;
	/**
	 * Stopping criterion, evaluated on the **last step** of each iteration.
	 * Omit it to simply run `maxIterations` times.
	 */
	until?: UntilPredicate;
	/**
	 * Hard cap on iterations. Defaults to 5, and must be at least 1.
	 *
	 * Unlike `timeoutMs`, this one **has** a default, on purpose: an iteration
	 * is a discrete, expensive unit, and "loop forever" must not be reachable by
	 * forgetting an argument. A judge that never says yes is the normal failure
	 * mode here, not the exotic one.
	 */
	maxIterations?: number;
};

/** A {@link WorkflowResult}, plus whether the bar was actually reached. */
export type LoopResult = WorkflowResult & {
	/** Iterations actually run, including the one that satisfied `until`. */
	iterations: number;
	/**
	 * Whether `until` was satisfied.
	 *
	 * Kept separate from `ok` because they answer different questions: `ok` says
	 * the last turn ran without a model error, `converged` says the work reached
	 * the bar. A loop that burns through `maxIterations` with every turn
	 * technically fine is `ok: true, converged: false` - and silently reporting
	 * that as success would hide the only thing worth knowing.
	 */
	converged: boolean;
};

/**
 * Runs the steps in a cycle until `until` is satisfied, or `maxIterations` is
 * reached.
 *
 * The output of the last step feeds the first step of the next iteration: the
 * coder receives the reviewer's remarks, which is the whole point.
 *
 * Lifetime, the two regimes:
 * - `"workflow"`: one subagent per distinct agent, alive for the whole loop.
 *   The reviewer does not repeat remarks it already made, the coder remembers
 *   what it was told. Cheaper per iteration, and the context grows.
 * - `"task"`: brand new subagents at every iteration. No accumulated bias,
 *   every review starts from the code alone. More expensive in re-reading, more
 *   honest about the result.
 *
 * A failing step stops the loop and is returned as is. The workflow never
 * throws on a model failure; it throws only on invalid arguments.
 */
export async function loop(options: LoopOptions): Promise<LoopResult> {
	const { steps, input, until, signal, timeoutMs } = options;
	const maxIterations = options.maxIterations ?? 5;

	if (steps.length === 0) throw new Error("loop: `steps` is empty");
	if (maxIterations < 1) throw new Error(`loop: \`maxIterations\` must be at least 1, got ${maxIterations}`);

	const pool = new SubagentPool(options);
	const all: Result[] = [];
	let current = input;
	let last: Result | undefined;
	let iterations = 0;
	let converged = false;

	try {
		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			iterations = iteration;
			let broken = false;

			for (const agent of steps) {
				if (signal?.aborted) {
					last = failed(agent.name, "aborted");
					all.push(last);
					broken = true;
					break;
				}

				// Keyed by name, not by iteration: in "workflow" lifetime the
				// reviewer of iteration 3 is the one that reviewed iteration 1.
				const subagent = await pool.acquire(agent, agent.name);
				try {
					last = await subagent.ask(current, { signal, timeoutMs });
				} finally {
					await pool.release(subagent);
				}

				all.push(last);
				if (!last.ok) {
					broken = true;
					break;
				}
				current = last.output;
			}

			if (broken) break;

			// `until` is judged on the last step - the reviewer's verdict, not
			// the coder's own opinion of its work.
			if (until && (await until(last as Result, iteration))) {
				converged = true;
				break;
			}
			// Without a criterion, running the requested number of times *is*
			// the goal, so that counts as converged.
			if (!until) converged = iteration === maxIterations;
		}
	} finally {
		await pool.closeAll();
	}

	// `last` is always set: `steps` is non-empty and `maxIterations` is at least 1.
	return { ...(last as Result), steps: all, iterations, converged };
}
