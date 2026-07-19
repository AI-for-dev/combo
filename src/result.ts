/**
 * `Result`: the single contract shared by everything else.
 *
 * A subagent returns a `Result`. A workflow returns a `Result` (or an array
 * of them). Workflows compose because they all speak this language - that is
 * the whole of what makes them composable.
 */

import type { AgentMessage } from "./session.ts";
import { emptyUsage, type Usage } from "./usage.ts";

/** One turn of work. */
export type Result = {
	/** Name of the agent that produced this result. */
	agent: string;
	/** Last assistant text. This is what feeds the next step. */
	output: string;
	/** Messages of the turn, for whoever wants to inspect the detail. */
	messages: AgentMessage[];
	/** Measurements of **this turn**. Cumulative usage lives on the `Subagent`. */
	usage: Usage;
	ok: boolean;
	/** Set if and only if `ok` is false. */
	error?: string;
};

/**
 * Builds a failed `Result`.
 *
 * The `usage` is **kept**: a subagent that crashed after 12k tokens really did
 * cost 12k tokens, and they must show up in the total.
 */
export function failed(
	agent: string,
	error: string,
	usage: Usage = emptyUsage(),
	messages: AgentMessage[] = [],
): Result {
	return { agent, output: "", messages, usage, ok: false, error };
}

/** A workflow result: the final answer, plus the trail of intermediate steps. */
export type WorkflowResult = Result & {
	/** Intermediate results, in execution order. */
	steps: Result[];
};
