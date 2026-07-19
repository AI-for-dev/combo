/**
 * `reduce`: N → 1. One agent synthesises the results of a fan-out.
 */

import type { Agent } from "./../agent.ts";
import { failed, type Result, type WorkflowResult } from "./../result.ts";
import { SubagentPool, type WorkflowOptions } from "./common.ts";

export type ReduceOptions = WorkflowOptions & {
	/** The agent doing the synthesis. */
	agent: Agent;
	/** What is being synthesised - typically a {@link fanOut}'s results. */
	results: Result[];
	/** The instruction, placed **before** the branches. */
	input: string;
	/**
	 * Turns the branches into the prompt the reducer receives.
	 *
	 * Defaults to {@link formatBranches}. Override it when the branches are not
	 * prose - a list of files, a diff - and the default headings would get in
	 * the way.
	 */
	format?: (results: readonly Result[], input: string) => string;
};

/**
 * Hands every branch to one agent and asks it for a single answer.
 *
 * **Failed branches are shown, not dropped.** A synthesis built from six
 * branches when two of them crashed, with nothing saying so, is a confident
 * lie - and it is the caller who is then unable to tell a thin answer from a
 * thin body of evidence. The reducer sees the failures, labelled, and can say
 * its coverage was incomplete. Pass only the successes if that is really what
 * you want: filtering an array needs no option.
 *
 * The returned `Result` is the synthesis itself; `steps` holds the branches it
 * was given followed by that synthesis, so the usage of the whole N→1 is
 * `sumUsage(result.steps.map(s => s.usage), wallMs)`.
 *
 * Lifetime is passed down but cannot change the shape of this combinator: one
 * agent, one turn, one spawn either way. It only matters here as an option a
 * caller may already be threading through a larger workflow.
 */
export async function reduce(options: ReduceOptions): Promise<WorkflowResult> {
	const { agent, results, input, signal, timeoutMs } = options;
	if (results.length === 0) throw new Error("reduce: `results` is empty - there is nothing to synthesise");

	const branches = results.slice();
	const format = options.format ?? formatBranches;

	if (signal?.aborted) {
		const aborted = failed(agent.name, "aborted");
		return { ...aborted, steps: [...branches, aborted] };
	}

	const pool = new SubagentPool(options);
	let synthesis: Result;
	try {
		const subagent = await pool.acquire(agent, agent.name);
		try {
			synthesis = await subagent.ask(format(branches, input), { signal, timeoutMs });
		} finally {
			await pool.release(subagent);
		}
	} finally {
		await pool.closeAll();
	}

	return { ...synthesis, steps: [...branches, synthesis] };
}

/**
 * The default rendering: the instruction, then one titled section per branch.
 *
 * A failed branch keeps its section and states its error. Numbering is what
 * lets the reducer refer to a branch - several branches often share an agent
 * name, so the name alone identifies nothing.
 */
export function formatBranches(results: readonly Result[], input: string): string {
	const sections = results.map((result, index) => {
		const title = `## ${index + 1}. ${result.agent}${result.ok ? "" : " (failed)"}`;
		const body = result.ok ? result.output.trim() || "(no output)" : `This branch failed: ${result.error ?? "unknown error"}`;
		return `${title}\n${body}`;
	});

	return `${input.trim()}\n\n${sections.join("\n\n")}`;
}
