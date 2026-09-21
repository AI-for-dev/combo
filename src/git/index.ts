/**
 * The working copy: the git a pipeline may do, the copies of the repository
 * two agents write in at once, and how their work comes home.
 *
 * Four files stacked in that order - `run.ts` runs git, `git.ts` and
 * `worktree.ts` say what may be run on the repository and on its copies,
 * `scratch.ts` is the one shape every caller of a copy wants, `land.ts` brings
 * patches home one at a time - and this is their door. `run.ts` is not on it:
 * running git is how, and everything outside asks what.
 */

export {
	branchName,
	commitAll,
	createBranch,
	diff,
	diffStat,
	isRepository,
	status,
	untracked,
	type GitResult,
} from "./git.ts";
export { land, landable, type Landed, type Landing } from "./land.ts";
export { scratchWorktree, type Scratch } from "./scratch.ts";
export {
	createWorktree,
	listWorktrees,
	removeWorktree,
	worktreePatch,
	type CreateWorktreeOptions,
	type Worktree,
} from "./worktree.ts";
