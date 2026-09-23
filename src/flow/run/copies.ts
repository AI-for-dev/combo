/**
 * The copies of a `copies: true` block: one per branch, made from the tree
 * the block stands in, and their patches brought home in branch order once
 * every branch has ended.
 *
 * Whoever opens, closes: a branch's copy is released in a `finally`, its
 * patch taken and its work committed on the copy's own branch first, so
 * nothing it wrote is lost whatever happens next. Landing is mechanical:
 * nothing is checked between patches, since a `check` after the block judges
 * the tree. A patch that does not apply, or could not be taken, stops the
 * landing there. What landed stays, and a failed branch's patch lands like
 * the others: nothing is undone.
 */

import type { GitPort, GitResult, Scratch } from "../../git/index.ts";
import type { Walked } from "./ended.ts";
import type { Walker } from "./walk.ts";

/** What a block asks of the `git` port. */
export type Copies = Pick<GitPort, "copy" | "reopen" | "land">;

/** What a branch's entry in its block's output says of its patch once the landing is over. */
export type Landing = {
	/** Everything the branch changed is in the tree: its patch applied, or it changed nothing. */
	readonly landed: boolean;
	/** Why not, when this branch's patch is the one that stopped the landing. */
	readonly refused?: string;
};

/**
 * The copy the branch `prefix` runs in, made from `tree`, and whether it is
 * one an earlier process opened. A resume takes back the copy the journal
 * left open while it is still there. A copy gone or moved, or one whose
 * patch never landed, holds work the tree does not: the branch is forgotten,
 * written down as `copy_lost`, and starts over in a fresh copy. A copy that
 * landed put its work in the tree, so what the branch did survives, and what
 * is left runs in a fresh copy. With no `copies`, a dry run's, nothing is made.
 */
export async function branchCopy(copies: Copies | undefined, tree: string | undefined, prefix: string, walker: Pick<Walker, "journal" | "replay">): Promise<{ readonly made?: GitResult<Scratch>; readonly again: boolean }> {
	const { journal, replay } = walker;
	const lose = (why: string) => {
		journal.append({ type: "copy_lost", path: prefix, why });
		replay?.forget(prefix);
	};
	const was = replay?.copy(prefix);
	if (was !== undefined && "landed" in was && !was.landed) lose("its patch never landed");
	const open = was !== undefined && "open" in was ? was.open : undefined;
	if (copies === undefined) return { again: open !== undefined };
	const { dir, branch, base } = open ?? {};
	if (dir !== undefined && branch !== undefined && base !== undefined) {
		const back = await copies.reopen(tree as string, prefix, { path: dir, branch, base });
		if (back.ok) return { made: back, again: true };
		lose(`its copy is gone: ${back.error}`);
	}
	return { made: await copies.copy(tree as string, prefix), again: false };
}

/**
 * Walks a branch in `made`, a copy of the tree, handing `keep` the patch it
 * left once the copy is gone. A copy that could not be made fails the branch
 * `unavailable` at its own path, and it runs nothing.
 */
export async function inCopy(made: GitResult<Scratch>, prefix: string, walk: (tree: string) => Promise<Walked>, keep: (patch: GitResult<string>) => void): Promise<Walked> {
	if (!made.ok) return { usage: [], failed: { path: prefix, error: { kind: "unavailable", message: `no copy of the tree could be made: ${made.error}` } } };
	try {
		return await walk(made.value.path);
	} finally {
		keep(await made.value.release());
	}
}

/**
 * Lands `patches` onto `tree` one at a time, in branch order. A branch with
 * no patch changed nothing, which counts as landed; once one stops the
 * landing, or the run is stopped, none after it lands.
 */
export async function landAll(copies: Copies, tree: string, patches: readonly (GitResult<string> | undefined)[], labels: readonly string[], signal: AbortSignal): Promise<Landing[]> {
	const landings: Landing[] = [];
	let stopped = false;
	for (const [index, label] of labels.entries()) {
		const patch = patches[index];
		if (stopped || signal.aborted) landings.push({ landed: false });
		else if (patch === undefined || (patch.ok && patch.value.trim() === "")) landings.push({ landed: true });
		else if (!patch.ok) landings.push({ landed: false, refused: `its patch could not be taken: ${patch.error}` });
		else {
			const put = await copies.land(tree, [{ label, patch: patch.value }]);
			landings.push(put.ok ? { landed: true } : { landed: false, refused: put.error ?? "the patch was refused" });
		}
		stopped ||= !(landings.at(-1) as Landing).landed;
	}
	return landings;
}
