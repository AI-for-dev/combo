/**
 * The review record: what one reviewer decided, and what it is still owed.
 *
 * A review is two things - a decision, which `verdict.ts` carries as a tool
 * call, and a list of things that must happen, which `ledger.ts` keeps - and
 * they are only ever read together: a round closes what it addressed, raises
 * what it found, and is approved when the reviewer said yes *and* nothing is
 * left open. This is the one place that joins them. A workflow asks the record
 * one question per round and never touches the tool or the list itself.
 */

import { createLedger, type Obligation } from "./ledger.ts";
import type { Result } from "./result.ts";
import type { ToolDefinition } from "./session.ts";
import { verdictTool, type Verdict } from "./verdict.ts";

/** Reads an approval out of prose, for a reviewer that holds no tool. */
export type ProseApproval = (review: Result, round: number) => boolean | Promise<boolean>;

/** How the record is built for a reviewer. */
export type ReviewRecordOptions = {
	/**
	 * Whether the reviewer decides through the `verdict` tool.
	 *
	 * Decided by the caller rather than read off the agent here, because a
	 * workflow may have a rule of its own - `pair` lets a caller's own
	 * `approved` predicate stand in for the tool, whatever the agent declares.
	 */
	byTool: boolean;
	/** How a round is read when it is not by tool. Ignored when it is. */
	inProse: ProseApproval;
	/** Obligations a previous run recorded, for a resumed one to carry on. */
	restored?: readonly Obligation[];
};

/** What one round of review amounted to. */
export type ReviewRound = {
	/**
	 * What the reviewer declared through the tool.
	 *
	 * Absent when it holds no tool, and **also** when it holds one and called
	 * nothing: a turn that failed to answer is not a refusal, and a reader has
	 * to be able to tell the two apart.
	 */
	verdict?: Verdict;
	/** Whether the reviewer said yes - by tool, or in prose when it holds none. */
	said: boolean;
	/** `said`, and nothing it raised is still open. This is what finished means. */
	approved: boolean;
	/** What it raised this round, as it wrote it. */
	raised: readonly string[];
};

/** One reviewer's record: the tool it decides with, and the list it is held to. */
export type ReviewRecord = {
	/** Offered to the reviewer through `customTools`. Absent when it decides in prose. */
	readonly tool?: ToolDefinition;
	/** Whether the reviewer decides through the tool. */
	readonly byTool: boolean;
	/** Still owed, in the order raised. What a round is asked about. */
	readonly open: readonly Obligation[];
	/** Everything raised, open and closed, in the order raised. */
	readonly all: readonly Obligation[];
	/**
	 * Closes a round: reads what the reviewer decided, writes it into the list,
	 * and says what the round amounted to.
	 *
	 * Closures are applied before anything new is raised, so a round cannot
	 * raise and close the same obligation in one call. When the reviewer called
	 * the tool several times the **last** call wins, because an agent that calls
	 * again has changed its mind. A review that did not run to completion
	 * decided nothing, whatever the tool collected on the way.
	 */
	close(review: Result, round: number): Promise<ReviewRound>;
};

/**
 * Builds the record for one reviewer, named as the ledger will name it.
 *
 * One per reviewer, never shared: the collector behind the tool is how the
 * decision gets back, and two agents writing into one would make their answers
 * indistinguishable. The tool is wired to the list here, once, so an id the
 * list has nothing open for is refused by the tool and named back to the agent
 * inside the same turn - the only moment it can still repair the mistake.
 */
export function reviewRecord(reviewer: string, options: ReviewRecordOptions): ReviewRecord {
	const ledger = createLedger(options.restored);
	const verdicts = options.byTool
		? verdictTool({
				knows: (id) => ledger.open.some((one) => one.id === id),
				open: () => ledger.open.map((one) => one.id),
			})
		: undefined;

	return {
		tool: verdicts?.tool,
		byTool: options.byTool,
		get open() {
			return ledger.open;
		},
		get all() {
			return ledger.all;
		},

		async close(review, round) {
			// Drained whatever happened to the turn: a verdict left behind by a
			// review that failed must not be read as the next round's.
			const given = verdicts?.take() ?? [];
			if (!review.ok) return { said: false, approved: false, raised: [] };

			if (!verdicts) {
				const said = await options.inProse(review, round);
				return { said, approved: said && ledger.settled, raised: [] };
			}

			const verdict = given.at(-1);
			for (const one of verdict?.resolved ?? []) {
				// A closure the list refuses - an id another agent raised - leaves
				// the obligation open, which is the outcome the caller reads anyway.
				ledger.close(one.id, reviewer, { how: one.how, reason: one.reason, at: round });
			}
			const raised = verdict?.raised ?? [];
			for (const text of raised) ledger.raise(reviewer, text, round);

			// A reviewer holding the tool and calling nothing has not approved:
			// guessing from its prose is the reading the tool exists to retire.
			const said = verdict?.approved ?? false;
			return { verdict, said, approved: said && ledger.settled, raised };
		},
	};
}
