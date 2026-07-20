/**
 * The git a pipeline is allowed to do - and nothing else.
 *
 * **A prompt is not a permission boundary.** An agent given `bash` and told
 * "never push" will push the day it decides that is what the user meant. So the
 * agent writes the commit *message* - a text, which is what a model is for - and
 * the irreversible act stays here, in code that can only do what it has
 * functions for.
 *
 * What has no function here, on purpose: `push`, `reset`, `rebase`, `checkout`
 * of an existing branch, anything `--force`, anything that rewrites history.
 * Adding one is a decision someone has to take in a diff, not an argument a
 * model can produce at runtime.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

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
async function git(cwd: string, args: string[]): Promise<GitResult<string>> {
	try {
		const { stdout } = await run("git", args, { cwd, maxBuffer: MAX_BUFFER });
		return { ok: true, value: stdout };
	} catch (cause) {
		const error = cause as { stderr?: string; message?: string };
		return { ok: false, error: (error.stderr || error.message || String(cause)).trim() };
	}
}

/** Whether `cwd` is inside a git working tree. */
export async function isRepository(cwd: string): Promise<boolean> {
	const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return result.ok && result.value.trim() === "true";
}

/** The current branch, or `undefined` on a detached head. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
	const result = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const name = result.ok ? result.value.trim() : "";
	return name && name !== "HEAD" ? name : undefined;
}

/** Porcelain status. Empty means a clean working tree - nothing to commit. */
export async function status(cwd: string): Promise<GitResult<string>> {
	return git(cwd, ["status", "--porcelain"]);
}

/** `git diff --stat` over tracked changes, including what is staged. */
export async function diffStat(cwd: string): Promise<GitResult<string>> {
	return git(cwd, ["diff", "HEAD", "--stat"]);
}

/**
 * The diff itself, truncated to `maxBytes`.
 *
 * It is written straight into a prompt, and an agent that receives half a
 * megabyte of diff writes a worse message than one that receives the first
 * pages and is told it was cut.
 */
export async function diff(cwd: string, maxBytes = 60_000): Promise<GitResult<string>> {
	const result = await git(cwd, ["diff", "HEAD"]);
	if (!result.ok) return result;
	const text = result.value;
	return {
		ok: true,
		value: text.length > maxBytes ? `${text.slice(0, maxBytes)}\n\n[diff truncated at ${maxBytes} bytes]` : text,
	};
}

/** Untracked files, which `git diff` does not show but `git add -A` will commit. */
export async function untracked(cwd: string): Promise<string[]> {
	const result = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
	if (!result.ok) return [];
	return result.value.split("\n").filter(Boolean);
}

/**
 * Creates a branch and switches to it.
 *
 * `checkout -b` fails when the branch exists, and that failure is kept: landing
 * on somebody else's branch is exactly what a dedicated branch is meant to
 * prevent.
 */
export async function createBranch(cwd: string, name: string): Promise<GitResult<string>> {
	const result = await git(cwd, ["checkout", "-b", name]);
	return result.ok ? { ok: true, value: name } : result;
}

/**
 * Stages everything and commits it, with the message read from stdin.
 *
 * `-F -` rather than `-m`: a message written by a model contains quotes,
 * backticks and newlines, and none of them should ever reach a shell. There is
 * no shell here at all, and this keeps it that way for the body too.
 *
 * Returns the short sha. A clean working tree is an error, not an empty commit.
 */
export async function commitAll(cwd: string, message: string): Promise<GitResult<string>> {
	const text = message.trim();
	if (!text) return { ok: false, error: "refusing to commit with an empty message" };

	const dirty = await status(cwd);
	if (!dirty.ok) return dirty;
	if (!dirty.value.trim()) return { ok: false, error: "nothing to commit: the working tree is clean" };

	const staged = await git(cwd, ["add", "-A"]);
	if (!staged.ok) return staged;

	const committed = await commitFromStdin(cwd, text);
	if (!committed.ok) return committed;

	const sha = await git(cwd, ["rev-parse", "--short", "HEAD"]);
	return sha.ok ? { ok: true, value: sha.value.trim() } : sha;
}

/** `git commit -F -`, with the message piped in rather than interpolated. */
function commitFromStdin(cwd: string, message: string): Promise<GitResult<string>> {
	return new Promise((resolve) => {
		const child = execFile("git", ["commit", "-F", "-"], { cwd, maxBuffer: MAX_BUFFER }, (cause, stdout, stderr) => {
			if (cause) resolve({ ok: false, error: (stderr || cause.message).trim() });
			else resolve({ ok: true, value: stdout });
		});
		child.stdin?.end(`${message}\n`);
	});
}

/**
 * A branch name from a request: `pi-subagent/add-a-cache`.
 *
 * Kept short and free of anything git dislikes. The prefix says who made it, so
 * a `git branch` listing shows at a glance what came from a pipeline.
 */
export function branchName(request: string, prefix = "pi-subagent"): string {
	const slug = request
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return `${prefix}/${slug || "work"}`;
}
