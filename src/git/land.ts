/**
 * Putting the work of several copies back into one tree.
 *
 * A copy per piece of work hands back a patch each. Two patches that each
 * apply cleanly on their own can still be wrong together: one renames what the
 * other calls, both add the same helper under two names, or the second simply
 * overlaps the first.
 *
 * So they go in **one at a time**, and the first that does not fit stops the
 * rest. Which patch broke the landing is then a fact rather than a bisection.
 *
 * **Nothing is undone.** A patch that does not fit is refused before it touches
 * anything. What already landed stays landed: rolling back would mean
 * discarding work, and every patch here was expensive to produce. The caller is
 * left with a tree it can read, a list of what went in, and the name of what
 * did not.
 */

import { applyPatch, status, type GitResult } from "./git.ts";

/** One piece of work, and something to call it in the report. */
export type Landing = {
	/** How this patch is named when something goes wrong with it. */
	label: string;
	/** The diff, as the copy gave it back. An empty one is skipped. */
	patch: string;
};

/** What reached the tree, and what did not. */
export type Landed = {
	/** Labels that went in, in the order they did. */
	applied: string[];
	/** The one that stopped it. Absent when everything went in. */
	rejected?: string;
	/** Everything landed. */
	ok: boolean;
	/** Set if and only if `ok` is false. */
	error?: string;
};

/**
 * Whether `repo` can take a landing at all, asked before anything is written.
 *
 * The same check {@link land} makes on its way in, exported because a caller
 * about to hand out copies of the repository needs the answer *first*: a patch
 * that cannot come back is a subtask paid for and thrown away. Both questions
 * are one call - git answers "not a repository" and "not clean" the same way.
 */
export async function landable(repo: string): Promise<GitResult<void>> {
	const dirty = await status(repo);
	if (!dirty.ok) return { ok: false, error: dirty.error };
	if (dirty.value.trim()) return { ok: false, error: "refusing to land onto a tree that already has changes in it" };
	return { ok: true, value: undefined };
}

/**
 * Applies each patch in turn.
 *
 * The tree must be clean to start with. Landing onto work somebody else is in
 * the middle of would make "which patch broke this" unanswerable, which is the
 * one question this function exists to answer.
 *
 * `requireCleanTree: false` is for the caller that put those changes there
 * itself, which is the only one that can tell them from somebody else's. A
 * flow lands each block's copies onto a tree holding what earlier blocks
 * landed: it knows exactly what it is adding to, and refusing it would make a
 * second round of work impossible.
 *
 * Order matters and is the caller's: these are applied as given.
 */
export async function land(
	repo: string,
	landings: readonly Landing[],
	options: { requireCleanTree?: boolean } = {},
): Promise<Landed> {
	const applied: string[] = [];

	if (options.requireCleanTree !== false) {
		const ready = await landable(repo);
		if (!ready.ok) return { applied, ok: false, error: ready.error };
	}

	for (const landing of landings) {
		// Nothing to land is not a failure: a copy nobody wrote in is a
		// legitimate outcome, and it has no place in `applied` either.
		if (!landing.patch.trim()) continue;

		const put = await applyPatch(repo, landing.patch);
		if (!put.ok) {
			return { applied, ok: false, rejected: landing.label, error: put.error };
		}
		applied.push(landing.label);
	}

	return { applied, ok: true };
}
