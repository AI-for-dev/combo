/**
 * The working tree as it stands, read without touching it: what it changed
 * since `HEAD`, untracked files included, and a commit of it for a copy to
 * start from.
 *
 * Both go through an index of their own, in a temporary file, so the
 * repository's index, its files and its refs stay as they were. `git add -N`
 * on the real index would do the first too, and leave every untracked file
 * showing as added in the person's `git status`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { head } from "../text.ts";
import { git, type GitResult } from "./run.ts";

type Git = (args: string[]) => Promise<GitResult<string>>;

/**
 * `git diff HEAD` with untracked files added, truncated at `maxBytes`.
 *
 * What an agent reading `diff` is handed: a new file is the ordinary case for
 * a coder, and `git diff` alone does not show one.
 */
export function treeDiff(cwd: string, maxBytes = 60_000): Promise<GitResult<string>> {
	return withTreeIndex(cwd, async (run) => {
		const result = await run(["diff", "--cached", "HEAD"]);
		return result.ok ? { ok: true, value: head(result.value, maxBytes, "diff") } : result;
	});
}

/**
 * A commit holding the tree as it stands, on top of `HEAD`, that no ref
 * points to.
 *
 * A copy made from `HEAD` would miss what the run already wrote and did not
 * commit, the patches an earlier block landed included, and its own patch
 * would then conflict with them on the way back.
 */
export function snapshot(cwd: string): Promise<GitResult<string>> {
	return withTreeIndex(cwd, async (run) => {
		const tree = await run(["write-tree"]);
		if (!tree.ok) return tree;
		const commit = await run(["commit-tree", tree.value.trim(), "-p", "HEAD", "-m", "combo: the tree a copy starts from"]);
		return commit.ok ? { ok: true, value: commit.value.trim() } : commit;
	});
}

/**
 * Runs `use` with git on an index that holds the whole tree: a copy of the
 * repository's, so git keeps what it knows of each file and hashes only what
 * changed, with every change added.
 */
async function withTreeIndex<T>(cwd: string, use: (run: Git) => Promise<GitResult<T>>): Promise<GitResult<T>> {
	const own = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
	if (!own.ok) return own;
	const holder = fs.mkdtempSync(path.join(os.tmpdir(), "combo-index-"));
	const index = path.join(holder, "index");
	const run: Git = (args) => git(cwd, args, { GIT_INDEX_FILE: index });
	try {
		const from = own.value.trim();
		// A repository whose index was never written holds nothing staged: `HEAD` is all of it.
		if (fs.existsSync(from)) fs.copyFileSync(from, index);
		else {
			const read = await run(["read-tree", "HEAD"]);
			if (!read.ok) return read;
		}
		const added = await run(["add", "-A"]);
		return added.ok ? await use(run) : added;
	} finally {
		fs.rmSync(holder, { recursive: true, force: true });
	}
}
