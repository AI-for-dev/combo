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
import type { ToolDefinition } from "./../session.ts";
import { openList, type Obligation } from "./../ledger.ts";
import { scratchWorktree, type Scratch } from "./../scratch.ts";
import { failed, type Result } from "./../result.ts";
import { reviewRecord } from "./../review.ts";
import { saysWord } from "./../text.ts";
import { sumUsage } from "./../usage.ts";
import { declaresVerdict, type Verdict } from "./../verdict.ts";
import type { WorkflowOptions } from "./options.ts";
import { SubagentPool } from "./pool.ts";

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
	/**
	 * Give this pair a copy of the repository to itself.
	 *
	 * Off by default. When it is on, both agents run in a git worktree made from
	 * `cwd`, and {@link PairResult.patch} carries what they did. Two pairs
	 * running at once then write to two trees, which is what turns "independent
	 * subtasks" from a promise into a fact.
	 *
	 * The copy belongs to the **pair**, not to each agent: a reviewer that had
	 * one of its own would be reading the code the worker did not touch.
	 *
	 * It lives here rather than on `WorkflowOptions` because `pair` is the only
	 * workflow that acts on it, and an option every workflow accepts while one
	 * honours it is a silent no-op for the rest.
	 */
	worktree?: boolean;
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
	/**
	 * The branch the work was committed to, when `worktree` asked for a copy.
	 *
	 * The copy itself is gone by the time a caller reads this, and the commit on
	 * this branch is what is left of it. A caller that drops the patch below has
	 * still lost nothing. Absent when the pair wrote nothing: a branch naming no
	 * work would only pile up.
	 */
	worktree?: string;
	/**
	 * What the work changed, as a patch against what it started from.
	 *
	 * Present with `worktree`, and empty when nothing was written. Applying it is
	 * nobody's job here: this workflow produces the change, it does not land it.
	 */
	patch?: string;
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
	const { worker, reviewer, input, signal } = options;
	const maxRounds = options.maxRounds ?? 3;
	if (maxRounds < 1) throw new Error(`pair: \`maxRounds\` must be at least 1, got ${maxRounds}`);

	// The reviewer decides through a tool when its definition asks for one, and a
	// caller's own predicate stands in for it. Built here rather than per round,
	// so a reviewer kept across rounds keeps its own record.
	const record = reviewRecord(reviewer.name, {
		byTool: !options.approved && declaresVerdict(reviewer.tools),
		inProse: options.approved ?? approvedByDefault,
	});

	const steps: Result[] = [];
	const startedAt = performance.now();
	let verdict: Verdict | undefined;
	let scratch: Scratch | undefined;
	let patch: string | undefined;
	let stranded: string | undefined;

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
		obligations: record.all,
		worktree: patch ? scratch?.branch : undefined,
		patch,
	});

	// The pool would answer this on the first turn; checking here spares making
	// a working copy for a pair that will never run in it.
	if (signal?.aborted) {
		const aborted = failed(worker.name, "aborted");
		steps.push(aborted);
		return outcome(aborted, undefined, 0, false);
	}

	// Both agents share the copy: a reviewer reading anywhere else would be
	// reading the code the worker did not touch. One that could not be made stops
	// the pair, rather than quietly writing into the tree it was meant to spare.
	if (options.worktree) {
		const made = await scratchWorktree(options.cwd ?? process.cwd(), input);
		if (!made.ok) {
			const stopped = failed(worker.name, `no working copy: ${made.error}`);
			steps.push(stopped);
			return outcome(stopped, undefined, 0, false);
		}
		scratch = made.value;
	}

	// A pair is a conversation between two agents: they keep their memory unless
	// the caller says otherwise. The default is written **after** the spread, not
	// before: a caller that builds its options by merging hands us
	// `lifetime: undefined` for an option nobody set, and an explicit `undefined`
	// spread over a default silently wins.
	//
	// Only the reviewer is offered the verdict tool. The worker writing into the
	// same collector would make the two agents' answers indistinguishable, and
	// pi's allowlist would refuse it anyway.
	const pool = new SubagentPool({
		...options,
		cwd: scratch?.path ?? options.cwd,
		lifetime: options.lifetime ?? "workflow",
		customTools: record.tool ? (agent) => (agent.name === reviewer.name ? [record.tool as ToolDefinition] : undefined) : options.customTools,
	});
	let work: Result | undefined;
	let review: Result | undefined;
	let rounds = 0;
	let approved = false;

	try {
		let task = input;
		for (let round = 1; round <= maxRounds; round++) {
			rounds = round;

			work = await pool.turn(worker, task);
			steps.push(work);
			if (!work.ok) break;

			review = await pool.turn(reviewer, reviewPrompt(input, work.output, round, { byTool: record.byTool, open: record.open }));
			steps.push(review);
			if (!review.ok) break;

			const decided = await record.close(review, round);
			verdict = decided.verdict;
			approved = decided.approved;
			// Breaking rather than returning: the copy is released in the `finally`
			// below, and a result built before that would carry no patch.
			if (approved) break;

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
		// Whoever opens closes, cancellation included. A patch that could not be
		// taken leaves the copy on disk rather than losing what is in it, and the
		// caller is told which copy: nothing else knows where the work went.
		if (scratch) {
			const released = await scratch.release();
			if (released.ok) patch = released.value;
			else stranded = `the working copy was not released: ${released.error}\nthe work is still in ${scratch.path}`;
		}
	}

	// `work` is always set: maxRounds is at least 1 and every path assigns it.
	const result = outcome(work as Result, review, rounds, approved);
	if (!stranded) return result;
	// Both failures, never one in place of the other: a model's and a
	// filesystem's are answered by different people.
	return { ...result, ok: false, error: result.error ? `${result.error}\n${stranded}` : stranded };
}

/** `LGTM` on a line of its own, whatever decoration the model put around it. */
function approvedByDefault(review: Result): boolean {
	return saysWord(review.output, APPROVAL);
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
