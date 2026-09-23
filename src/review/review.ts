/**
 * The review record: what one reviewer decided, and what it is still owed.
 *
 * A review is two things - a decision, which `verdict.ts` carries as a tool
 * call, and a list of things that must happen, which `ledger.ts` keeps - and
 * they are only ever read together: a round closes what it addressed, raises
 * what it found, and is approved when the reviewer said yes *and* nothing is
 * left open. This is the one place that joins them. A workflow asks the record
 * one question per round and never touches the tool or the list itself - and
 * the record says how it is to be asked: what is still owed, and how the
 * decision is read, in the same words for every reviewer.
 */

import type { Agent } from "../agent.ts";
import { createLedger, openList, type Ledger, type Obligation } from "./ledger.ts";
import type { Result } from "../result.ts";
import { saysWord } from "../text.ts";
import { declaresVerdict, VERDICT_TOOL, verdictTool, type Verdict } from "./verdict.ts";
import type { WorkflowOptions } from "../workflows/options.ts";

/** Reads an approval out of prose, for a reviewer that holds no tool. */
export type ProseApproval = (review: Result, round: number) => boolean | Promise<boolean>;

/** How the record is built for a reviewer. */
export type ReviewRecordOptions = {
	/**
	 * The word the reviewer says alone when it decides in prose.
	 *
	 * Named in the terms it is asked on and read off its answer by the same
	 * record, so the two cannot drift apart.
	 */
	word: string;
	/**
	 * A caller's own reading of the prose.
	 *
	 * It stands in for the word **and** for the tool: a reviewer whose
	 * definition names `verdict` still decides in prose when the caller says
	 * how, because the caller's rule is the nearer one.
	 */
	approved?: ProseApproval;
	/** Obligations a previous run recorded, for a resumed one to carry on. */
	restored?: readonly Obligation[];
	/**
	 * The list the record writes to, read at every use. Defaults to one of its
	 * own, holding `restored`.
	 *
	 * A flow's ledger belongs to the scope that opens it, not to a reviewer:
	 * every verdict node naming that scope writes to it, and a reviewer a
	 * memory scope keeps may answer to the next ledger its scope opens.
	 */
	ledger?: () => Ledger;
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

/** One reviewer's record: how it is asked, what it decides with, and the list it is held to. */
export type ReviewRecord = {
	/** Whether the reviewer decides through the tool. */
	readonly byTool: boolean;
	/** Still owed, in the order raised. What a round is asked about. */
	readonly open: readonly Obligation[];
	/** Everything raised, open and closed, in the order raised. */
	readonly all: readonly Obligation[];
	/**
	 * What the reviewer is told at the end of every round: what it still owes,
	 * by id, and how its decision is read - a call to the tool, or the word
	 * alone. Written here once, so a pair and an audit ask in the same words.
	 */
	terms(): string;
	/**
	 * The tools to offer through `customTools`: the verdict tool to this
	 * reviewer and to nobody else, `others` to everybody else.
	 *
	 * Only the reviewer, because two agents writing into one collector would
	 * make their answers indistinguishable, and pi's allowlist would refuse it
	 * anyway. A reviewer that decides in prose changes nothing: `others` stands.
	 */
	offer(others?: WorkflowOptions["customTools"]): WorkflowOptions["customTools"];
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
export function reviewRecord(reviewer: Agent, options: ReviewRecordOptions): ReviewRecord {
	const own = createLedger(options.restored);
	const list = options.ledger ?? (() => own);
	const byTool = !options.approved && declaresVerdict(reviewer.tools);
	const inProse: ProseApproval = options.approved ?? ((review) => saysWord(review.output, options.word));
	const verdicts = byTool
		? verdictTool({
				knows: (id) => list().open.some((one) => one.id === id),
				open: () => list().open.map((one) => one.id),
			})
		: undefined;

	return {
		byTool,
		get open() {
			return list().open;
		},
		get all() {
			return list().all;
		},

		terms() {
			const owed = list().open;
			const parts: string[] = [];
			if (owed.length) parts.push("Still open, from your earlier rounds:", openList(owed), "");
			if (!verdicts) {
				parts.push(`Answer ${options.word} alone when you have nothing left to ask for.`);
				return parts.join("\n");
			}
			parts.push(`End by calling the \`${VERDICT_TOOL}\` tool: that call is what is read as your decision.`);
			if (owed.length) {
				parts.push("Name in `resolved` every id above you are done with. One you leave out stays open, and the work is not finished while anything is.");
			}
			return parts.join("\n");
		},

		offer(others) {
			if (!verdicts) return others;
			return (agent) => (agent.name === reviewer.name ? [verdicts.tool] : others?.(agent));
		},

		async close(review, round) {
			// Drained whatever happened to the turn: a verdict left behind by a
			// review that failed must not be read as the next round's.
			const given = verdicts?.take() ?? [];
			if (!review.ok) return { said: false, approved: false, raised: [] };
			const ledger = list();

			if (!verdicts) {
				const said = await inProse(review, round);
				return { said, approved: said && ledger.settled, raised: [] };
			}

			const verdict = given.at(-1);
			for (const one of verdict?.resolved ?? []) {
				// A closure the list refuses - an id another agent raised - leaves
				// the obligation open, which is the outcome the caller reads anyway.
				ledger.close(one.id, reviewer.name, { how: one.how, reason: one.reason, at: round });
			}
			const raised = verdict?.raised ?? [];
			for (const text of raised) ledger.raise(reviewer.name, text, round);

			// A reviewer holding the tool and calling nothing has not approved:
			// guessing from its prose is the reading the tool exists to retire.
			const said = verdict?.approved ?? false;
			return { verdict, said, approved: said && ledger.settled, raised };
		},
	};
}
