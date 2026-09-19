/**
 * One owner per thing, decided here rather than agreed between members.
 *
 * A board lets a member *announce* what it is taking. Measured, that is not
 * enough and cannot be made enough: three members read the board within
 * 130ms of each other, were each handed nothing because nobody had posted yet,
 * and all three then claimed the same file. Announcing into a medium that was
 * empty when you looked is a race whatever the prompt says.
 *
 * So a claim is **granted, never declared**. First to ask holds it, everyone
 * else is refused and told who holds it, and the refusal is the useful part: it
 * turns contention into somebody to talk to ("ask `scout#3`, it holds
 * `src/parser.ts`") instead of two members doing one job.
 *
 * **The keys are a list, not free text.** The same run posted `console.ts`,
 * `src/reporters/console.ts` and `I will handle src/reporters/console.ts` for
 * one file. A lease keyed on what a model writes would have granted all three
 * and arbitrated nothing, so a caller that knows what there is to claim says
 * so, and a key that is not on the list is refused with the list - the same
 * discipline as an agent name that is not on the roster.
 *
 * Pure data, like `ledger.ts` next door: no pi, no disk, no bus. Whoever hands
 * the mechanism to a member announces it.
 */

/** Something held, and who holds it. */
export type Holding = {
	/** What is held, exactly as it was taken. */
	key: string;
	/** The member holding it. */
	heldBy: string;
};

/**
 * What a `take` did, or why it did nothing.
 *
 * `heldBy` is set only when the refusal is contention, because that is the one
 * a member can act on: it names somebody to ask.
 */
export type TakeOutcome = { ok: true } | { ok: false; error: string; heldBy?: string };

/** The leases, and the rules that govern them. */
export type Claims = {
	/**
	 * Grants `key` to `member`, or refuses and says who has it.
	 *
	 * Taking what you already hold is granted: it is not contention, and a
	 * member told "you cannot have it, you have it" learns nothing.
	 */
	take(member: string, key: string): TakeOutcome;
	/** Gives `key` up. Only its holder can, and a key nobody holds is `false`. */
	release(member: string, key: string): boolean;
	/**
	 * Everything `member` was holding, given up at once, and what that was.
	 *
	 * For the workflow above, when a member dies or is stopped: claims left
	 * hanging by a member that is gone are work nobody will do and nobody can
	 * take. The keys come back so the run can say which ones, rather than
	 * leaving a reader to notice the gap.
	 */
	releaseAll(member: string): readonly string[];
	/** Who holds `key`, if anyone. */
	owner(key: string): string | undefined;
	/** What is held right now, in the order it was taken. */
	open(): readonly Holding[];
};

/** What there is to claim, when the caller knows. */
export type ClaimsOptions = {
	/**
	 * The things that may be claimed.
	 *
	 * Left out, any key may be taken - which is honest for a caller that cannot
	 * enumerate the work, and weaker: two spellings of one thing are then two
	 * things, and both are granted.
	 */
	keys?: readonly string[];
};

/**
 * An empty set of claims.
 *
 * Keys are compared exactly, after trimming. Nothing else is normalised: a key
 * is whatever the caller decided it is, and folding case or stripping a `./`
 * would be this file guessing at what two strings have in common.
 */
export function createClaims(options: ClaimsOptions = {}): Claims {
	const known = options.keys ? new Set(options.keys.map((key) => key.trim())) : undefined;
	// Insertion order, which is the order they were taken: a reader of `open()`
	// sees the run as it happened.
	const held = new Map<string, string>();

	return {
		take(member, key) {
			const wanted = key.trim();
			if (!wanted) return { ok: false, error: "a claim names something: `key` was empty" };
			if (known && !known.has(wanted)) {
				return { ok: false, error: `there is nothing called \`${wanted}\` to claim - there is ${[...known].join(", ")}` };
			}

			const holder = held.get(wanted);
			if (holder === member) return { ok: true };
			if (holder) return { ok: false, error: `\`${wanted}\` is held by ${holder} - ask ${holder}, or take something else`, heldBy: holder };

			held.set(wanted, member);
			return { ok: true };
		},

		release(member, key) {
			const wanted = key.trim();
			if (held.get(wanted) !== member) return false;
			held.delete(wanted);
			return true;
		},

		releaseAll(member) {
			const gone = [...held].filter(([, holder]) => holder === member).map(([key]) => key);
			for (const key of gone) held.delete(key);
			return gone;
		},

		owner(key) {
			return held.get(key.trim());
		},

		open() {
			return [...held].map(([key, heldBy]) => ({ key, heldBy }));
		},
	};
}

/** What is held, as a member reads it: one line each, in the order taken. */
export function heldList(holdings: readonly Holding[]): string {
	return holdings.map((one) => `${one.key}: ${one.heldBy}`).join("\n");
}
