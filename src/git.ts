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
 *
 * `deleteBranch` is the one that looks like an exception and is not: `-d` makes
 * git refuse any branch holding commits nothing else reaches, so it can clear
 * away a name and never work.
 */

import { git, gitWithInput, type GitResult } from "./git-run.ts";
import { head } from "./text.ts";

export type { GitResult };

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

/**
 * The commit `HEAD` is on, as a sha.
 *
 * A sha rather than a branch name, for whoever needs to come back to where
 * something started: a branch moves, and a diff against one that has moved is a
 * diff against work somebody else did.
 */
export async function headSha(cwd: string): Promise<GitResult<string>> {
	const result = await git(cwd, ["rev-parse", "HEAD"]);
	return result.ok ? { ok: true, value: result.value.trim() } : result;
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
	return { ok: true, value: head(result.value, maxBytes, "diff") };
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

	const committed = await gitWithInput(cwd, ["commit", "-F", "-"], text);
	if (!committed.ok) return committed;

	const sha = await git(cwd, ["rev-parse", "--short", "HEAD"]);
	return sha.ok ? { ok: true, value: sha.value.trim() } : sha;
}

/**
 * A branch name from a request: `combo/add-a-cache`.
 *
 * Kept short and free of anything git dislikes. The prefix says who made it, so
 * a `git branch` listing shows at a glance what came from a pipeline.
 */
export function branchName(request: string, prefix = "combo"): string {
	const slug = request
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return `${prefix}/${slug || "work"}`;
}

/**
 * Deletes a branch, if nothing would be lost with it.
 *
 * `-d`, never `-D`: git refuses a branch holding commits nothing else reaches,
 * and that refusal is the whole safety of this function. It exists to clear away
 * a branch that was made and never written on, not to discard work.
 */
export async function deleteBranch(cwd: string, name: string): Promise<GitResult<string>> {
	const result = await git(cwd, ["branch", "-d", name]);
	return result.ok ? { ok: true, value: name } : result;
}

/**
 * Applies a patch to the working tree, or says why it would not.
 *
 * Checked before it is applied, so a patch that does not fit leaves the tree
 * exactly as it was. `--3way` is not used: it writes conflict markers into the
 * files and calls that a success, and a caller left to discover markers in a
 * tree it thought was clean is worse off than one told the patch was refused.
 *
 * This writes where the agents were going to write anyway, so it is not the
 * kind of act the rest of this file keeps out. It adds no commit and moves no
 * ref: what lands stays in the working tree for a human to look at.
 */
export async function applyPatch(cwd: string, patch: string): Promise<GitResult<void>> {
	if (!patch.trim()) return { ok: false, error: "refusing to apply an empty patch" };

	const fits = await gitWithInput(cwd, ["apply", "--check"], patch);
	if (!fits.ok) return fits;

	const applied = await gitWithInput(cwd, ["apply"], patch);
	return applied.ok ? { ok: true, value: undefined } : applied;
}

