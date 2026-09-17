/**
 * `pair`: one worker, one reviewer, talking until the work is accepted.
 *
 * This is `loop` over two agents with two differences that earn it its own name:
 *
 * - the result is **the worker's last piece of work**, not the reviewer's
 *   verdict. `loop` returns its last step, which here is the word `LGTM` - true,
 *   useless, and the wrong thing to hand to whatever comes next;
 * - `approved` is reported separately from `ok`, like `converged` for `loop`:
 *   burning through the rounds with the reviewer still unhappy is not a success,
 *   and collapsing the two would hide the only thing worth knowing.
 */

import type { Agent } from "./../agent.ts";
import { createLedger, openList, type Ledger, type Obligation } from "./../ledger.ts";
import { failed, type Result } from "./../result.ts";
import { saysWord } from "./../text.ts";
import { sumUsage, type Usage } from "./../usage.ts";
import { declaresVerdict, lastVerdict, verdictTool, type Verdict } from "./../verdict.ts";
import { SubagentPool, type WorkflowOptions } from "./common.ts";

/** The word a reviewer that holds no verdict tool says when it is satisfied. */
export const APPROVAL = "LGTM";

/** The two agents, the work, and what counts as an approval. */
export type PairOptions = WorkflowOptions & {
	/** The agent doing the work. Needs the tools to actually do it. */
	worker: Agent;
	/** The agent reviewing it. Read-only is the point. */
	reviewer: Agent;
	/** The work to do. It is also what a resumed build re-issues verbatim. */
	input: string;
	/**
	 * Decides whether the review is an approval, overriding both defaults below.
	 *
	 * Without it, a reviewer whose `tools:` names `verdict` is read from its tool
	 * call, and any other reviewer from {@link APPROVAL} alone on a line.
	 */
	approved?: (review: Result, round: number) => boolean | Promise<boolean>;
	/**
	 * How many worker→review exchanges at most. Defaults to 3.
	 *
	 * Same reasoning as `loop`'s `maxIterations`: a reviewer that never says yes
	 * is the normal failure mode, not the exotic one, and each round is two
	 * turns of a model.
	 */
	maxRounds?: number;
};

/** The worker's last output, plus how the pair got there and whether it was accepted. */
export type PairResult = Result & {
	/** What the pair was asked for. A result that cannot say so cannot be resumed. */
	input: string;
	/** Every turn, worker and reviewer alternating, in order. */
	steps: Result[];
	/** The last review, whether it approved or not. */
	review?: Result;
	/** Worker→review exchanges actually run. Reaching `maxRounds` is not approval. */
	rounds: number;
	/** Whether the reviewer accepted the work. Distinct from `ok`. */
	approved: boolean;
	/**
	 * The last decision the reviewer declared through the verdict tool.
	 *
	 * Absent when the reviewer holds no such tool, and **also** when it holds one
	 * and called nothing. The second case is a turn that failed to answer rather
	 * than a refusal, and a reader has to be able to tell the two apart: with
	 * `approved: false` and no verdict, the reviewer never decided.
	 */
	verdict?: Verdict;
	/**
	 * What the reviewer raised, and what became of each of them.
	 *
	 * Empty when the reviewer holds no verdict tool. When it does, this is what
	 * `approved` is computed from: the reviewer saying yes over an obligation it
	 * never closed does not finish the work, and a run that stopped short says
	 * which ones are still open rather than only that it stopped.
	 */
	obligations: readonly Obligation[];
};

/**
 * Runs the worker, has it reviewed, and sends the remarks back until the
 * reviewer is satisfied.
 *
 * The lifetime defaults to `"workflow"`, and here that is not a detail: the
 * reviewer that reads round three is the one that wrote the remarks in round
 * two, so it does not repeat itself, and the worker remembers what it was told.
 * Pass `lifetime: "task"` for the opposite regime - fresh eyes every round, more
 * expensive in re-reading, more honest about the result.
 *
 * A failing worker or reviewer stops the pair: there is nothing to review, and
 * nothing to fix. The failure comes back as the result, never as a throw.
 */
export async function pair(options: PairOptions): Promise<PairResult> {
	const { worker, reviewer, input, signal, timeoutMs } = options;
	const maxRounds = options.maxRounds ?? 3;
	if (maxRounds < 1) throw new Error(`pair: \`maxRounds\` must be at least 1, got ${maxRounds}`);

	// The reviewer decides through a tool when its definition asks for one. Built
	// here rather than per round, so a reviewer kept across rounds keeps its own.
	const speaksByTool = !options.approved && declaresVerdict(reviewer.tools);
	const verdicts = speaksByTool ? verdictTool() : undefined;
	const ledger = createLedger();

	const isApproved = options.approved ?? approvedByDefault;
	const steps: Result[] = [];
	const startedAt = performance.now();
	let verdict: Verdict | undefined;

	const outcome = (work: Result, review: Result | undefined, rounds: number, approved: boolean): PairResult => ({
		...work,
		input,
		usage: sumUsage(
			steps.map((step) => step.usage),
			performance.now() - startedAt,
		),
		steps,
		review,
		rounds,
		approved,
		verdict,
		obligations: ledger.all,
	});

	if (signal?.aborted) {
		const aborted = failed(worker.name, "aborted");
		steps.push(aborted);
		return outcome(aborted, undefined, 0, false);
	}

	// A pair is a conversation between two agents: they keep their memory unless
	// the caller says otherwise. The default is written **after** the spread, not
	// before: a caller that builds its options by merging hands us
	// `lifetime: undefined` for an option nobody set, and an explicit `undefined`
	// spread over a default silently wins.
	// Only the reviewer is offered the tool. The worker writing into the same
	// collector would make the two agents' answers indistinguishable, and pi's
	// allowlist would refuse it anyway.
	const pool = new SubagentPool({
		...options,
		lifetime: options.lifetime ?? "workflow",
		customTools: verdicts ? (agent) => (agent.name === reviewer.name ? [verdicts.tool] : undefined) : options.customTools,
	});
	let work: Result | undefined;
	let review: Result | undefined;
	let rounds = 0;

	try {
		let task = input;
		for (let round = 1; round <= maxRounds; round++) {
			rounds = round;

			if (signal?.aborted) {
				work = failed(worker.name, "aborted");
				steps.push(work);
				break;
			}

			const doing = await pool.acquire(worker, worker.name);
			try {
				work = await doing.ask(task, { signal, timeoutMs });
			} finally {
				await pool.release(doing);
			}
			steps.push(work);
			if (!work.ok) break;

			const judging = await pool.acquire(reviewer, reviewer.name);
			try {
				const prompt = reviewPrompt(input, work.output, round, { byTool: speaksByTool, open: ledger.open });
				review = await judging.ask(prompt, { signal, timeoutMs });
			} finally {
				await pool.release(judging);
			}
			steps.push(review);
			if (!review.ok) break;

			if (verdicts) {
				verdict = lastVerdict(verdicts.take());
				if (verdict) record(ledger, verdict, reviewer.name, round);
				// Two things have to hold: the reviewer has nothing further to ask,
				// and nothing it raised earlier is still open. A reviewer holding the
				// tool and calling nothing has not approved either - guessing from its
				// prose is the reading this tool exists to retire.
				if (verdict?.approved && ledger.settled) return outcome(work, review, round, true);
			} else if (await isApproved(review, round)) {
				return outcome(work, review, round, true);
			}

			// The review itself, never the verdict's summary of it: the reviewer's
			// definition is what disciplines this text - five remarks at most, each
			// naming a file, a line and a failure - and a field the model fills a
			// second time says the same thing worse.
			//
			// The worker is about to run in round+1, so what is left after that is
			// what it needs to know - being told "last round" one round late is
			// how a pair ends with the important fix still unmade.
			task = remarksPrompt(review.output, maxRounds - round - 1);
		}
	} finally {
		await pool.closeAll();
	}

	// `work` is always set: maxRounds is at least 1 and every path assigns it.
	return outcome(work as Result, review, rounds, false);
}

/** `LGTM` on a line of its own, whatever decoration the model put around it. */
function approvedByDefault(review: Result): boolean {
	return saysWord(review.output, APPROVAL);
}

/**
 * Writes a round's verdict into the ledger: what it closed, then what it raised.
 *
 * Closures first, so an obligation raised this round cannot be closed by the
 * same call. A closure the ledger refuses - an unknown id, one the reviewer did
 * not raise - leaves it open, which is the outcome the caller reads anyway.
 */
function record(ledger: Ledger, verdict: Verdict, by: string, round: number): void {
	for (const one of verdict.resolved) ledger.close(one.id, by, { how: one.how, reason: one.reason, at: round });
	for (const text of verdict.raised) ledger.raise(by, text, round);
}

/** How the reviewer is asked to answer, and what it still owes. */
export type ReviewPromptOptions = {
	/** Whether the reviewer decides through the `verdict` tool. */
	byTool?: boolean;
	/** Obligations still open, which it is asked to answer for by id. */
	open?: readonly Obligation[];
};

/** What the reviewer is asked: the goal, what was done, and what is still owed. */
export function reviewPrompt(goal: string, work: string, round: number, options: ReviewPromptOptions = {}): string {
	const owed = options.open ?? [];
	const parts = [
		round === 1 ? "Review this work." : `Review this work again - this is round ${round}.`,
		"",
		"It was asked to:",
		goal.trim(),
		"",
		"What was done:",
		work.trim(),
		"",
	];

	if (owed.length) parts.push("Still open, from your earlier rounds:", openList(owed), "");
	parts.push("Read the code itself rather than trusting the summary.");

	if (!options.byTool) {
		parts.push(`Answer ${APPROVAL} alone when you have nothing left to ask for.`);
		return parts.join("\n");
	}

	parts.push("End by calling the `verdict` tool: that call is what is read as your decision.");
	if (owed.length) {
		parts.push(
			"Name in `resolved` every id above you are done with. One you leave out stays open, and the work is not finished while anything is.",
		);
	}
	return parts.join("\n");
}

/** What the worker gets back: the remarks, and how much room is left. */
export function remarksPrompt(review: string, remaining: number): string {
	return [
		"Your work was reviewed. Address each remark, or say plainly why you did not.",
		"",
		review.trim(),
		"",
		remaining > 0
			? "Then summarise what you changed."
			: "This is the last round: fix what matters most and summarise what you changed.",
	].join("\n");
}
