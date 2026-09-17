/**
 * What is left to do, as a list nobody can lose track of.
 *
 * A review produces two kinds of thing: a decision, which `src/verdict.ts`
 * carries, and a set of things that must happen before the work is finished.
 * Asking the reviewer to restate the second set every round puts us back to
 * matching one round's prose against another's, where "is this the same remark
 * as last time" is a guess.
 *
 * So this code holds the list. An obligation gets an id when it first appears
 * and keeps it, and the agent answers a closed question per id instead of
 * writing its remarks again.
 *
 * Three rules make it safe, and they are here rather than in a prompt:
 *
 * - **Only whoever opened an obligation may close it.** A worker cannot declare
 *   its own work accepted.
 * - **An obligation nobody mentions stays open.** A model that forgets has not
 *   approved, and failing closed is the only default that cannot be talked
 *   round.
 * - **Nothing is rewritten.** An obligation opens, it closes, and it keeps the
 *   text it was opened with.
 *
 * A judgement stays a judgement through all of this. What changes is that the
 * unfinished set is explicit, and each judgement in it covers one sentence
 * rather than the whole of the work.
 */

/** How an obligation stopped being open. */
export type Closure = {
	/** `"addressed"` when the work was done, `"withdrawn"` when it was dropped. */
	how: "addressed" | "withdrawn";
	/** Why. Kept whatever the outcome: a withdrawal without a reason is a silent drop. */
	reason?: string;
	/** The round it closed in, so a reader can see what moved and what did not. */
	at: number;
};

/** One thing that has to happen before the work is finished. */
export type Obligation = {
	/** Short and stable: the agent has to echo it, and it never changes. */
	readonly id: string;
	/** The agent that raised it. The only one allowed to close it. */
	readonly openedBy: string;
	/** As it was written. Never rewritten - a reworded obligation is a new one. */
	readonly text: string;
	/** The round it first appeared in. */
	readonly openedAt: number;
	/** Absent while it is open. */
	closed?: Closure;
};

/** What a `close` did, or why it did nothing. */
export type CloseOutcome = { ok: true; obligation: Obligation } | { ok: false; error: string };

/** The list, and the rules that govern it. */
export type Ledger = {
	/** Raises one and returns it, with the id it will keep. */
	raise(openedBy: string, text: string, round: number): Obligation;
	/**
	 * Closes one, if `by` is the agent that opened it.
	 *
	 * A refusal comes back as `ok: false` rather than a throw: an agent naming
	 * the wrong id is a runtime outcome the caller reports, not a programming
	 * error.
	 */
	close(id: string, by: string, closure: Closure): CloseOutcome;
	/** Every obligation, open and closed, in the order they were raised. */
	readonly all: readonly Obligation[];
	/** Those still open, in the same order. What a round is asked about. */
	readonly open: readonly Obligation[];
	/** Whether nothing is left open. This is what "finished" means. */
	readonly settled: boolean;
};

/** A fresh, empty ledger. Its ids start at `o1`. */
export function createLedger(): Ledger {
	const obligations: Obligation[] = [];

	return {
		raise(openedBy, text, round) {
			const obligation: Obligation = {
				id: `o${obligations.length + 1}`,
				openedBy,
				text: text.trim(),
				openedAt: round,
			};
			obligations.push(obligation);
			return obligation;
		},

		close(id, by, closure) {
			const obligation = obligations.find((one) => one.id === id);
			if (!obligation) return { ok: false, error: `no obligation "${id}"` };
			if (obligation.closed) return { ok: false, error: `${id} is already closed` };
			if (obligation.openedBy !== by) {
				return { ok: false, error: `${id} was raised by ${obligation.openedBy}, and only ${obligation.openedBy} may close it` };
			}

			obligation.closed = { ...closure, reason: closure.reason?.trim() || undefined };
			return { ok: true, obligation };
		},

		get all() {
			return obligations;
		},
		get open() {
			return obligations.filter((one) => !one.closed);
		},
		get settled() {
			return obligations.every((one) => one.closed);
		},
	};
}

/** Obligations as the lines an agent is asked to answer for, one id per line. */
export function openList(obligations: readonly Obligation[]): string {
	return obligations.map((one) => `${one.id}: ${one.text}`).join("\n");
}
