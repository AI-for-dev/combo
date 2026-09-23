/**
 * The `git` port of a flow run: what a flow's nodes may ask of git, and
 * nothing more.
 *
 * A flow commits, reads its tree's diff, and gives the branches of a block a
 * copy each whose patches come home. Each is one function below, built on the
 * rest of this module, and the runner reaches git through this and nothing
 * else. As in `git.ts`, what has no function here cannot happen: there is no
 * push, no reset and no rebase.
 */

import { branchExists, branchName, commitAll, createBranch, currentBranch, isRepository, status } from "./git.ts";
import { land, type Landed, type Landing } from "./land.ts";
import type { GitResult } from "./run.ts";
import { reopenScratch, scratchWorktree, type Scratch } from "./scratch.ts";
import { snapshot, treeDiff } from "./tree.ts";

/** How a flow run reaches git. Injected, so the run stage and the runner never run git of their own. */
export type GitPort = {
	/** Whether `cwd` is inside a git working tree. */
	isRepository(cwd: string): Promise<boolean>;
	/** `git diff HEAD` plus untracked files, truncated at 60 000 bytes. */
	diff(cwd: string): Promise<GitResult<string>>;
	/** The branch `HEAD` is on, `undefined` when detached. */
	currentBranch(cwd: string): Promise<string | undefined>;
	/** Whether the branch `name` exists. */
	hasBranch(cwd: string, name: string): Promise<boolean>;
	/**
	 * A branch of the run's own, `combo/<slug of request>`, suffixed `-2`, `-3`
	 * while the name is taken, created from `HEAD` and switched to.
	 */
	openBranch(cwd: string, request: string): Promise<GitResult<string>>;
	/** Stages everything and commits it: the short sha, or `undefined` on a clean tree. */
	commit(cwd: string, message: string): Promise<GitResult<string | undefined>>;
	/** A copy of the tree as it stands, uncommitted changes included, for one branch of a block. */
	copy(cwd: string, label: string): Promise<GitResult<Scratch>>;
	/** The copy a previous process made for `label` and left open, taken back when it is still there. */
	reopen(cwd: string, label: string, copy: Omit<Scratch, "release">): Promise<GitResult<Scratch>>;
	/** Applies patches one at a time onto a tree holding the run's own changes. */
	land(cwd: string, landings: readonly Landing[]): Promise<Landed>;
};

/** The {@link GitPort} of a real repository. */
export function gitPort(): GitPort {
	return {
		isRepository,
		diff: (cwd) => treeDiff(cwd),
		currentBranch,
		hasBranch: branchExists,
		async openBranch(cwd, request) {
			const name = branchName(request);
			for (let n = 1; ; n++) {
				const candidate = n === 1 ? name : `${name}-${n}`;
				if (!(await branchExists(cwd, candidate))) return createBranch(cwd, candidate);
			}
		},
		async commit(cwd, message) {
			const dirty = await status(cwd);
			if (!dirty.ok || dirty.value.trim() === "") return dirty.ok ? { ok: true, value: undefined } : dirty;
			return commitAll(cwd, message);
		},
		async copy(cwd, label) {
			const base = await snapshot(cwd);
			return base.ok ? scratchWorktree(cwd, label, base.value) : base;
		},
		reopen: reopenScratch,
		// The tree holds what the run wrote, which the copies started from.
		land: (cwd, landings) => land(cwd, landings, { requireCleanTree: false }),
	};
}
