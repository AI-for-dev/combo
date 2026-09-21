/**
 * Putting the work of several copies back into one tree.
 *
 * `pair` with `worktree` gives each piece of work a copy of the repository and
 * hands back a patch. Two patches that each apply cleanly on their own can
 * still be wrong together: one renames what the other calls, both add the same
 * helper under two names, or the second simply overlaps the first.
 *
 * So they go in **one at a time**, and the project's own check runs between
 * them when one was given. Which patch broke the tree is then a fact rather
 * than a bisection.
 *
 * **Nothing is undone.** A patch that does not fit is refused before it touches
 * anything, and a check that fails stops the rest where it is. What already
 * landed stays landed: rolling back would mean discarding work, and every patch
 * here was expensive to produce. The caller is left with a tree it can read, a
 * list of what went in, and the name of what did not.
 */

import { applyPatch, status, type GitResult } from "./git.ts";
import type { Verification, Verify } from "../verify.ts";

/** One piece of work, and something to call it in the report. */
export type Landing = {
	/** How this patch is named when something goes wrong with it. */
	label: string;
	/** The diff, as `pair` gave it back. An empty one is skipped. */
	patch: string;
};

/** What reached the tree, what did not, and what the check said in between. */
export type Landed = {
	/** Labels that went in, in the order they did. */
	applied: string[];
	/** The one that stopped it. Absent when everything went in. */
	rejected?: string;
	/** The check after each application, when a `verify` was given, in order. */
	checks: Verification[];
	/** Everything landed and the last check passed. */
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
 * Applies each patch in turn, checking the tree between them.
 *
 * The tree must be clean to start with. Landing onto work somebody else is in
 * the middle of would make "which patch broke this" unanswerable, which is the
 * one question this function exists to answer.
 *
 * `requireCleanTree: false` is for the caller that put those changes there
 * itself, which is the only one that can tell them from somebody else's. A
 * delivery lands its subtasks, then lands the fixes its audit asked for onto a
 * tree holding the first lot: the second call knows exactly what it is adding
 * to, and refusing it would make the option useless the moment an audit asks
 * for anything.
 *
 * Order matters and is the caller's: these are applied as given.
 */
export async function land(
	repo: string,
	landings: readonly Landing[],
	options: { verify?: Verify; requireCleanTree?: boolean } = {},
): Promise<Landed> {
	const applied: string[] = [];
	const checks: Verification[] = [];

	if (options.requireCleanTree !== false) {
		const ready = await landable(repo);
		if (!ready.ok) return { applied, checks, ok: false, error: ready.error };
	}

	for (const landing of landings) {
		// Nothing to land is not a failure: a pair that wrote nothing is a
		// legitimate outcome, and it has no place in `applied` either.
		if (!landing.patch.trim()) continue;

		const put = await applyPatch(repo, landing.patch);
		if (!put.ok) {
			return { applied, checks, ok: false, rejected: landing.label, error: put.error };
		}
		applied.push(landing.label);

		const check = await options.verify?.();
		if (!check) continue;
		checks.push(check);
		if (!check.ok) {
			return {
				applied,
				checks,
				ok: false,
				rejected: landing.label,
				error: `the check failed after ${landing.label}`,
			};
		}
	}

	return { applied, checks, ok: true };
}
