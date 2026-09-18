/**
 * A working copy with a lifetime: made for one piece of work, and released when
 * that work is done.
 *
 * `worktree.ts` holds the primitives; this holds the one shape every caller
 * wants from them. Making a copy, taking its patch and removing it are three
 * calls that only ever happen together, and the order they go in is the whole
 * safety of the thing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { branchName, commitAll, deleteBranch, headSha } from "./git.ts";
import type { GitResult } from "./git-run.ts";
import { truncate } from "./text.ts";
import { createWorktree, removeWorktree, worktreePatch } from "./worktree.ts";

/** A copy made for one piece of work, and the way to get the work back out. */
export type Scratch = {
	/** Where it is. This is what a subagent gets as its working directory. */
	readonly path: string;
	/** The branch it holds. Named after the work, so `git branch` reads. */
	readonly branch: string;
	/**
	 * Takes the patch, then removes the copy and the directory holding it.
	 *
	 * Idempotent, and safe to call in a `finally`: a second call gives back the
	 * patch the first one took, not an empty one, so a caller that releases
	 * explicitly and again in a `finally` cannot lose it. A patch that could not
	 * be taken leaves everything where it is - the caller gets the error and the
	 * work stays on disk, which is the only order these two can go in.
	 */
	release(): Promise<GitResult<string>>;
};

/**
 * A copy of `repo` for one piece of work, outside the repository.
 *
 * Outside on purpose: a copy inside the tree its own patch is taken against
 * would show up in that patch. It lives under the system's temporary directory
 * and is removed by {@link Scratch.release}.
 *
 * The base is resolved to a commit rather than kept as a branch name, so the
 * patch is against what the work actually started from even if the branch has
 * moved since.
 */
export async function scratchWorktree(repo: string, label: string): Promise<GitResult<Scratch>> {
	const head = await headSha(repo);
	if (!head.ok) return head;
	const base = head.value;

	const holder = fs.mkdtempSync(path.join(os.tmpdir(), "combo-scratch-"));
	const at = path.join(holder, "tree");
	// The suffix keeps two concurrent pieces of work off one branch, which is
	// the whole point of a copy each.
	const branch = `${branchName(label)}-${path.basename(holder).slice(-6)}`;

	const made = await createWorktree(repo, { path: at, branch, base });
	if (!made.ok) {
		fs.rmSync(holder, { recursive: true, force: true });
		return made;
	}

	// The patch once taken: what makes a second `release()` answer as the first.
	let taken: string | undefined;
	return {
		ok: true,
		value: {
			path: at,
			branch,
			async release() {
				if (taken !== undefined) return { ok: true, value: taken };

				const patch = await worktreePatch(at, base);
				if (!patch.ok) return patch;

				// Committed on the branch before the copy goes, so the work is
				// recoverable from the repository and not only from the string this
				// returns. A caller that drops the patch has still lost nothing.
				if (patch.value) {
					const committed = await commitAll(at, subject(label));
					if (!committed.ok) return committed;
				}

				const gone = await removeWorktree(repo, at, { patched: true });
				if (!gone.ok) return gone;

				// A branch nobody wrote on names nothing, and one per piece of work
				// would pile up in the caller's repository. `-d` refuses to take any
				// that turned out to hold something.
				if (!patch.value) await deleteBranch(repo, branch);

				taken = patch.value;
				fs.rmSync(holder, { recursive: true, force: true });
				return patch;
			},
		},
	};
}

/**
 * The commit subject for one piece of work: a single short line.
 *
 * git folds a subject spread over several lines into one, so a task stated in a
 * paragraph becomes a heading no log can show. It is cut here instead.
 */
function subject(label: string): string {
	return `combo: ${truncate(label, 64)}`;
}
