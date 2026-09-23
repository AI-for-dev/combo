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

import type { GitPort, GitResult } from "../../git/index.ts";
import type { Walked } from "./ended.ts";

/** What a block asks of the `git` port. */
export type Copies = Pick<GitPort, "copy" | "land">;

/** What a branch's entry in its block's output says of its patch once the landing is over. */
export type Landing = {
	/** Everything the branch changed is in the tree: its patch applied, or it changed nothing. */
	readonly landed: boolean;
	/** Why not, when this branch's patch is the one that stopped the landing. */
	readonly refused?: string;
};

/**
 * Walks a branch in a copy of `tree`, handing `keep` the patch it left once
 * the copy is gone. A copy that cannot be made fails the branch `unavailable`
 * at its own path, and it runs nothing.
 */
export async function inCopy(copies: Copies, tree: string, prefix: string, walk: (tree: string) => Promise<Walked>, keep: (patch: GitResult<string>) => void): Promise<Walked> {
	const made = await copies.copy(tree, prefix);
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
