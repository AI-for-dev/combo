/**
 * `chain`: 1 → 1 → 1. The output of step *n* is the input of step *n+1*.
 */

import type { Agent } from "./../agent.ts";
import type { Result, WorkflowResult } from "./../result.ts";
import type { WorkflowOptions } from "./options.ts";
import { SubagentPool } from "./pool.ts";

/** What a chain needs: the agents, in order, and the task for the first one. */
export type ChainOptions = WorkflowOptions & {
	/** The agents to run, in order. The same agent may appear several times. */
	steps: Agent[];
	/** The task given to the first step. */
	input: string;
};

/**
 * Runs the agents in sequence, feeding each one the previous output.
 *
 * Lifetime is the whole point of this combinator:
 * - `"task"`: one spawn per step. Every step reads the code afresh, with no
 *   accumulated bias, and pays to re-read it.
 * - `"workflow"`: one spawn per *distinct agent*, reused when it comes back.
 *   The reviewer does not repeat its remarks, the coder remembers what it was
 *   told. This is the "team" regime.
 *
 * A failing step stops the chain - there is no input left for the next one -
 * and its `Result` is returned as is. The workflow itself never throws.
 *
 * Whoever opens, closes: every subagent this function spawned is closed in the
 * `finally`, cancellation included.
 */
export async function chain(options: ChainOptions): Promise<WorkflowResult> {
	const { steps, input } = options;
	if (steps.length === 0) throw new Error("chain: `steps` is empty");

	const pool = new SubagentPool(options);
	const results: Result[] = [];
	let current = input;
	let last: Result | undefined;

	try {
		for (const agent of steps) {
			// Keyed by name: in "workflow" lifetime, the same agent appearing
			// twice is the *same* subagent, with its memory intact.
			last = await pool.turn(agent, current);
			results.push(last);
			if (!last.ok) break;
			current = last.output;
		}
	} finally {
		await pool.closeAll();
	}

	// `last` is always set here: `steps` is non-empty and every branch assigns it.
	return { ...(last as Result), steps: results };
}
