/**
 * Running git, and what comes back from it.
 *
 * `git.ts` and `worktree.ts` each carried the same ten-line runner, and `git.ts`
 * carried two more near-identical functions for piping a commit message and a
 * patch to git's standard input.
 *
 * Only the running lives here. **Which** commands are allowed stays the decision
 * `git.ts` makes, in its own file, where a reader asking "can this thing push"
 * answers it by reading a list of functions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Output is capped: a diff can be enormous, and it ends up in a prompt. */
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * What a git call gives back: a value, or git's own words about why not.
 *
 * A typed result rather than an exception, for the same reason a workflow turns
 * a model failure into `ok: false`: a commit that could not be made is an
 * outcome the caller must decide about, not a crash.
 */
export type GitResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs one git command. Arguments are an array: no shell, no interpolation. */
export async function git(cwd: string, args: string[]): Promise<GitResult<string>> {
	try {
		const { stdout } = await exec("git", args, { cwd, maxBuffer: MAX_BUFFER });
		return { ok: true, value: stdout };
	} catch (cause) {
		const error = cause as { stderr?: string; message?: string };
		return { ok: false, error: (error.stderr || error.message || String(cause)).trim() };
	}
}

/**
 * The same, with `input` piped to git's standard input.
 *
 * This is how a commit message and a patch both get in. A message written by a
 * model holds quotes, backticks and newlines, and a patch is worse; neither
 * should ever reach a shell, and there is no shell here at all.
 *
 * A trailing newline is added when there is none: git wants one, and a caller
 * building a patch by joining lines is the ordinary case.
 */
export function gitWithInput(cwd: string, args: string[], input: string): Promise<GitResult<string>> {
	return new Promise((resolve) => {
		const child = execFile("git", args, { cwd, maxBuffer: MAX_BUFFER }, (cause, stdout, stderr) => {
			if (cause) resolve({ ok: false, error: (stderr || cause.message).trim() });
			else resolve({ ok: true, value: stdout });
		});
		child.stdin?.end(input.endsWith("\n") ? input : `${input}\n`);
	});
}
