/**
 * The list of a repository's copies, touched by one git command at a time.
 *
 * git keeps that list under `.git/worktrees/` and takes no lock on it. `worktree
 * add` writes a new copy's files there one by one, and every command that walks
 * the list - another `add`, `remove`, `list`, `branch -d` - reads each copy's
 * files as it finds them. Caught between two writes, it reads an empty
 * `commondir` and dies (`failed to read .git/worktrees/tree/commondir:
 * Success`); a `remove` that takes the last copy deletes `.git/worktrees/`
 * under an `add` about to write in it. Two copies made and released at once,
 * which is what a copy each is for, are enough.
 *
 * So those commands queue here, per repository: in this process, which is
 * where a run makes its copies.
 */

import path from "node:path";
import { git, type GitResult } from "./run.ts";

/** The tail of each repository's queue, keyed by its common git directory. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `args` in `cwd` once every command queued before it on the same
 * repository has ended.
 *
 * Keyed by the common git directory rather than by `cwd`: a copy and the
 * repository it was made from share the one list, and so does a subdirectory.
 */
export async function gitOnRegistry(cwd: string, args: string[]): Promise<GitResult<string>> {
	const key = await commonDir(cwd);
	const before = queues.get(key) ?? Promise.resolve();
	const turn = before.then(() => git(cwd, args));
	queues.set(key, turn);
	try {
		return await turn;
	} finally {
		if (queues.get(key) === turn) queues.delete(key);
	}
}

/** The common git directory of `cwd`, or `cwd` itself where git names none. */
async function commonDir(cwd: string): Promise<string> {
	const result = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return result.ok ? result.value.trim() : path.resolve(cwd);
}
