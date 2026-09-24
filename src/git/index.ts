/**
 * The working copy: the git a run may do, the copies of the repository
 * two agents write in at once, and how their work comes home.
 *
 * Files stacked in that order - `run.ts` runs git, `registry.ts` queues
 * what touches the list of copies, `git.ts` and `worktree.ts` say what may
 * be run on the repository and on its copies,
 * `tree.ts` reads the tree without touching it, `scratch.ts` is the one shape
 * every caller of a copy wants, `land.ts` brings patches home one at a time,
 * and `port.ts` is what a flow run may ask of all of them - and this is their
 * door. `run.ts` is not on it: running git is how, and everything outside
 * asks what.
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
export { gitPort, type GitPort } from "./port.ts";
export { scratchWorktree, type Scratch } from "./scratch.ts";
export {
	createWorktree,
	listWorktrees,
	removeWorktree,
	worktreePatch,
	type CreateWorktreeOptions,
	type Worktree,
} from "./worktree.ts";
