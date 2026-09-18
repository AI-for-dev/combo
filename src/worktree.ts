/**
 * Working copies, so two agents can write at once without writing over each
 * other.
 *
 * `git.ts` covers the repository; this covers the copies of it. The split is
 * what that file's own header asks for: what has no function there does not
 * exist, and worktrees would mix two concepts under one roof.
 *
 * The rule it adds to the ones `git.ts` already holds: **a worktree whose work
 * has not been captured is not removed**. Losing what a child wrote to make
 * room is the one failure here that a rerun cannot undo, and every other
 * failure in this library is a `Result` with `ok: false` and another attempt.
 *
 * What has no function here, for the same reason as next door: `push`, `merge`,
 * `rebase`, anything that rewrites history. A caller who wants a worktree gone
 * whatever it holds deletes the directory itself, which is not an act this
 * module performs on anyone's behalf.
 */

import { git, type GitResult } from "./git-run.ts";

/** One working copy, as git reports it. */
export type Worktree = {
	/** Absolute path of the copy. */
	path: string;
	/** The branch checked out there, or `undefined` on a detached head. */
	branch?: string;
	/** The commit it is on. */
	head?: string;
};

/** What to create, and from where. */
export type CreateWorktreeOptions = {
	/** Where the copy goes. It must not exist. */
	path: string;
	/** The branch to create there. One that exists is an error, deliberately. */
	branch: string;
	/** What to branch from. Defaults to `HEAD`. */
	base?: string;
};

/**
 * Creates a working copy on a branch of its own.
 *
 * The branch is created here rather than checked out: landing two children on
 * one branch is exactly what a copy each is meant to prevent, so a name that
 * already exists fails, as it does in `createBranch`.
 */
export async function createWorktree(repo: string, options: CreateWorktreeOptions): Promise<GitResult<Worktree>> {
	const result = await git(repo, ["worktree", "add", "-b", options.branch, options.path, options.base ?? "HEAD"]);
	if (!result.ok) return result;
	return { ok: true, value: { path: options.path, branch: options.branch } };
}

/** Every working copy of this repository, the main one included. */
export async function listWorktrees(repo: string): Promise<GitResult<Worktree[]>> {
	const result = await git(repo, ["worktree", "list", "--porcelain"]);
	if (!result.ok) return result;

	const worktrees: Worktree[] = [];
	let current: Worktree | undefined;
	for (const line of result.value.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { path: line.slice("worktree ".length) };
			worktrees.push(current);
		} else if (!current) {
			continue;
		} else if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice("branch refs/heads/".length);
		}
	}
	return { ok: true, value: worktrees };
}

/**
 * What a working copy has that `base` does not, as a patch.
 *
 * `add --intent-to-add` first, because a file the child created is the ordinary
 * case for a coder and `git diff` does not show one. That writes to the index of
 * the copy, which is acceptable: the copy exists to be read and then dropped,
 * and a patch missing every new file would be worse than a touched index.
 */
export async function worktreePatch(worktree: string, base: string, maxBytes = 200_000): Promise<GitResult<string>> {
	const staged = await git(worktree, ["add", "--intent-to-add", "--all"]);
	if (!staged.ok) return staged;

	const result = await git(worktree, ["diff", "--binary", base]);
	if (!result.ok) return result;

	const text = result.value;
	return {
		ok: true,
		value: text.length > maxBytes ? `${text.slice(0, maxBytes)}\n\n[patch truncated at ${maxBytes} bytes]` : text,
	};
}

/**
 * Removes a working copy, unless it still holds work nobody captured.
 *
 * `patched` is the caller saying it has the patch in hand. Without it, a copy
 * with changes in it stays where it is and the error names the path, so whoever
 * reads the run can go and look. A clean copy goes either way: there is nothing
 * to lose.
 */
export async function removeWorktree(repo: string, path: string, options: { patched: boolean }): Promise<GitResult<void>> {
	if (!options.patched) {
		const dirty = await git(path, ["status", "--porcelain"]);
		// An unreadable copy is not a reason to remove it blind.
		if (!dirty.ok) return dirty;
		if (dirty.value.trim()) {
			return { ok: false, error: `refusing to remove ${path}: it holds changes no patch was taken of` };
		}
	}

	// git refuses a copy with changes in it, which is the same guard as the one
	// above and answers to nothing the caller can tell it. `patched: true` is the
	// caller saying the work is somewhere else now, and that is the only thing
	// this flag is for.
	const args = ["worktree", "remove", ...(options.patched ? ["--force"] : []), path];
	const result = await git(repo, args);
	return result.ok ? { ok: true, value: undefined } : result;
}
