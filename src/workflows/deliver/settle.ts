/**
 * How a delivery's work reaches its tree.
 *
 * Either every pair writes in a copy of the repository and the copies come
 * home one patch at a time, with the project's check between them; or the
 * pairs share the tree they were told to write in and only the check runs.
 * Which one, whether the tree can take it, and what became of every batch are
 * one policy, decided once here and asked about by the delivery: `land.ts` is
 * the mechanism any caller may use, this is what `deliver` does with it.
 */

import { land, landable, type GitResult, type Landed } from "../../git/index.ts";
import { truncate } from "../../text.ts";
import type { Verification, Verify } from "../../verify.ts";
import type { PairResult } from "./pair.ts";

/** What a delivery says about its copies before any work runs. */
export type SettleOptions = {
	/** The tree the work is for, and that the copies come home to. */
	cwd: string;
	/**
	 * What the caller said about copies: `true` and `false` are obeyed as written,
	 * and nothing at all means the number of writers decides.
	 */
	worktree?: boolean;
	/** How many pairs are about to write. Two in one directory read each other. */
	writers: number;
	/** The project's own check, run after every batch and between patches. */
	verify?: Verify;
};

/** A delivery's way of putting work in the tree, for as long as it runs. */
export type Settling = {
	/** Whether each pair gets a copy of the repository. */
	readonly isolate: boolean;
	/**
	 * Puts a batch's work back, when it was done in copies, and runs the check.
	 *
	 * One call rather than two at each of the two places a batch of pairs
	 * finishes: with nobody isolated this is the check on its own, and with the
	 * copies it is what `land` ran between the patches. What comes back is the
	 * tree as it stands.
	 */
	settle(batch: readonly PairResult[]): Promise<Verification | undefined>;
	/** What became of each batch's patches, one entry per batch. Empty when the tree was shared. */
	readonly landings: readonly Landed[];
	/** Every patch reached the tree. Work that never did is not delivered, whatever was said about it. */
	readonly landed: boolean;
};

/**
 * Decides how this delivery's work reaches the tree, and checks the tree can
 * take it.
 *
 * With more than one writer and nothing said, every pair gets a copy: two
 * subagents in one directory read each other, so a shared directory is a
 * channel between them and not only a race. One writer stays where it was told
 * to write - it has nobody to leak to, and a delivery on your own repository is
 * the case isolating it would ruin.
 *
 * Isolation nobody asked for has to be possible *before* the work starts.
 * Asked for explicitly it stays the caller's problem and fails where it always
 * did - at the copy - but a delivery that chose this itself must not pay for two
 * subtasks and then discover their patches cannot come home. The refusal gives
 * both ways out, in both spellings, because both kinds of caller hit it: a
 * script sets the option, and whoever typed a command has only the flag.
 */
export async function settling(options: SettleOptions): Promise<GitResult<Settling>> {
	const { cwd, worktree, writers, verify } = options;
	const isolate = worktree ?? writers > 1;

	if (isolate && worktree === undefined) {
		const ready = await landable(cwd);
		if (!ready.ok) {
			const why = `${writers} subtasks need a copy of the repository each, and ${ready.error}`;
			const how = "commit or stash what is there, or say worktree: false (`--worktree=false`) to let them share one tree";
			return { ok: false, error: `${why}. ${how}` };
		}
	}

	const landings: Landed[] = [];
	return {
		ok: true,
		value: {
			isolate,
			landings,
			get landed() {
				return landings.every((one) => one.ok);
			},
			async settle(batch) {
				if (!isolate) return await verify?.();

				const landed = await land(
					cwd,
					// A short label, not the subtask: a report naming three patches by
					// their full text is one nobody reads.
					batch.map((one) => ({ label: truncate(one.input, 60), patch: one.patch ?? "" })),
					// Only the first landing of a delivery meets a tree it did not
					// write. Refusing the later ones would break the option on any
					// audit that asks for a fix.
					//
					// This asks the tree a second time, on purpose. The pre-flight above
					// answered before the work, so that no subtask is paid for that
					// cannot come home; this one answers now, minutes later, on the tree
					// as it stands - the pairs wrote in copies, but the person whose
					// tree it is may have written in it meanwhile, and landing onto that
					// would make "which patch broke this" unanswerable, which is the one
					// question `land` exists to answer. The first is a warning, this is
					// the guard, and one `git status` is what telling them apart costs.
					{ verify, requireCleanTree: landings.length === 0 },
				);
				landings.push(landed);
				// The last check `land` ran is the tree as it stands. With nothing to
				// land it ran none, and the check still has to be asked.
				return landed.checks.at(-1) ?? (await verify?.());
			},
		},
	};
}
