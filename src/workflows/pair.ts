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
import { failed, type Result } from "./../result.ts";
import { sumUsage, type Usage } from "./../usage.ts";
import { SubagentPool, type WorkflowOptions } from "./common.ts";

/** The word a reviewer says when it has nothing left to ask for. */
export const APPROVAL = "LGTM";

export type PairOptions = WorkflowOptions & {
	/** The agent doing the work. Needs the tools to actually do it. */
	worker: Agent;
	/** The agent reviewing it. Read-only is the point. */
	reviewer: Agent;
	input: string;
	/**
	 * Decides whether the review is an approval. Defaults to {@link APPROVAL}
	 * alone on a line, which is the convention `agents/reviewer.md` already
	 * writes.
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

export type PairResult = Result & {
	/** Every turn, worker and reviewer alternating, in order. */
	steps: Result[];
	/** The last review, whether it approved or not. */
	review?: Result;
	rounds: number;
	/** Whether the reviewer accepted the work. Distinct from `ok`. */
	approved: boolean;
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

	const isApproved = options.approved ?? approvedByDefault;
	const steps: Result[] = [];
	const startedAt = performance.now();

	const outcome = (work: Result, review: Result | undefined, rounds: number, approved: boolean): PairResult => ({
		...work,
		usage: sumUsage(
			steps.map((step) => step.usage),
			performance.now() - startedAt,
		),
		steps,
		review,
		rounds,
		approved,
	});

	if (signal?.aborted) {
		const aborted = failed(worker.name, "aborted");
		steps.push(aborted);
		return outcome(aborted, undefined, 0, false);
	}

	// A pair is a conversation between two agents: they keep their memory unless
	// the caller says otherwise.
	const pool = new SubagentPool({ lifetime: "workflow", ...options });
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
				review = await judging.ask(reviewPrompt(input, work.output, round), { signal, timeoutMs });
			} finally {
				await pool.release(judging);
			}
			steps.push(review);
			if (!review.ok) break;

			if (await isApproved(review, round)) return outcome(work, review, round, true);

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
	return review.output
		.trim()
		.split("\n")
		.some((line) => line.replace(/[*_`#\s.]/g, "").toUpperCase() === APPROVAL);
}

/** What the reviewer is asked: the goal, then what was done about it. */
export function reviewPrompt(goal: string, work: string, round: number): string {
	return [
		round === 1 ? "Review this work." : `Review this work again - this is round ${round}.`,
		"",
		"It was asked to:",
		goal.trim(),
		"",
		"What was done:",
		work.trim(),
		"",
		"Read the code itself rather than trusting the summary.",
		`Answer ${APPROVAL} alone when you have nothing left to ask for.`,
	].join("\n");
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
