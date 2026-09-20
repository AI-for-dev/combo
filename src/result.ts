/**
 * `Result`: the single contract shared by everything else.
 *
 * A subagent returns a `Result`. A workflow returns a {@link WorkflowResult}:
 * a `Result` too, with the steps that led to it. Workflows compose because they
 * all speak this language - that is the whole of what makes them composable,
 * and it is what lets a pipeline step or a tool call read any of them the same
 * way.
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
	/** Whether the turn ran to completion. A model error is `false`, never a throw. */
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

/**
 * A workflow result: the workflow read as one turn of work, plus the trail of
 * steps that led to it.
 *
 * The `Result` part is the workflow's own reading of itself, decided where the
 * workflow is written and nowhere else: a chain is its last step, a reduce its
 * synthesis, a fan-out its branches labelled one after the other, an
 * orchestration its synthesis or its planner. `usage` is the whole workflow's;
 * `ok` says every turn ran, and never more than that - a bar reached or missed
 * is a field of its own, `converged`, `approved`.
 */
export type WorkflowResult = Result & {
	/** Intermediate results, in execution order. */
	steps: Result[];
};

/** How several results are laid out for whoever reads them - a model, mostly. */
export type JoinOptions<T extends Result> = {
	/**
	 * Number the sections.
	 *
	 * Several branches often share an agent name, so the name alone identifies
	 * nothing; the number is what a reader refers to a branch by.
	 */
	numbered?: boolean;
	/**
	 * The note beside a heading, in parentheses: `(failed)`, `(reviewed and
	 * approved)`. Defaults to `failed` on a failure and nothing otherwise.
	 */
	note?: (result: T) => string | undefined;
};

/**
 * Several outputs read as one text: each under a heading naming its agent, an
 * empty output said to be empty, a failure marked as such with its error where
 * the output would be.
 *
 * A failed branch keeps its section rather than vanishing: a synthesis, a
 * report or a next step reading six sections when eight ran would take the
 * silence for completeness. This was written six times, with four heading
 * grammars and three spellings of "nothing"; whoever compared a tool's answer
 * with a pipeline's read two conventions for one fact.
 */
export function joinOutputs<T extends Result>(results: readonly T[], options: JoinOptions<T> = {}): string {
	const note = options.note ?? ((result: T) => (result.ok ? undefined : "failed"));
	return results
		.map((result, index) => {
			const aside = note(result);
			const title = `## ${options.numbered ? `${index + 1}. ` : ""}${result.agent}${aside ? ` (${aside})` : ""}`;
			const body = result.ok ? result.output.trim() || "(no output)" : (result.error ?? "unknown error");
			return `${title}\n\n${body}`;
		})
		.join("\n\n");
}

/** Turns an abort into the same failure a combinator returns for it. */
export function abortError(signal: AbortSignal | undefined): string | undefined {
	return signal?.aborted ? "aborted" : undefined;
}
