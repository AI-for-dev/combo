/**
 * How a `verdict:` node answers: the `verdict` tool, bound at each visit to
 * the ledger of the scope it names, through the review record that already
 * keeps the three rules (only the opener closes, unmentioned stays open,
 * nothing is rewritten).
 *
 * The tool is fixed when the subagent is spawned, and a subagent a memory
 * scope keeps may outlive the ledger it first wrote to, so the record reads
 * the ledger through the slot rather than holding one.
 */

import type { Agent } from "../../agent.ts";
import type { Result } from "../../result.ts";
import { reviewRecord, type Ledger } from "../../review/index.ts";
import type { ToolDefinition } from "../../session.ts";
import { toolsOffered } from "../../subagent.ts";
import type { Submission } from "./submit.ts";

/** The `verdict` tool of one subagent, and the record behind it. */
export type VerdictSlot = {
	readonly tool: ToolDefinition;
	/** The closing part of a turn writing to `ledger`: its open obligations by id, and how the decision is read. */
	terms(ledger: Ledger): string;
	/**
	 * What the turn decided, written into `ledger`, as a `verdict:` node's
	 * output. With no ledger, the turn was another node's: what it called is
	 * drained and nothing is written.
	 */
	take(result: Result, ledger?: Ledger): Promise<Submission | undefined>;
};

/** A slot for `reviewer`, whose `tools:` already name `verdict`. */
export function verdictSlot(reviewer: Agent): VerdictSlot {
	let bound: Ledger | undefined;
	let round = 0;
	// The word is never read: the reviewer holds the tool, so the record decides by it.
	const record = reviewRecord(reviewer, { word: "APPROVED", ledger: () => bound as Ledger });
	const [tool] = toolsOffered(record.offer()?.(reviewer), reviewer.name);
	return {
		tool: tool as ToolDefinition,
		terms(ledger) {
			bound = ledger;
			return record.terms();
		},
		async take(result, ledger) {
			bound = ledger;
			const decided = await record.close(ledger === undefined ? { ...result, ok: false } : result, ++round);
			if (ledger === undefined || !result.ok) return undefined;
			if (decided.verdict === undefined) return { ok: false, message: "the turn ended with no `verdict` call" };
			const { remarks } = decided.verdict;
			return { ok: true, value: { approved: decided.approved, ...(remarks !== undefined && { remarks }) } };
		},
	};
}
