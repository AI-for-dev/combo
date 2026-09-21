/**
 * The second of `/build`'s two stops: the message an agent writes, the commit
 * this code makes.
 *
 * The split is the whole safety story - see `src/git.ts`. It lives apart from
 * the state machine that calls it because it is the only part of `/build` that
 * reaches history, and because "the agent writes the message, this code makes
 * the commit" is a boundary that should be readable in one file.
 */

import { branchName, type Agent } from "../../src/index.ts";
import { firstLines, refuse, watched } from "../command.ts";
import type { CommandCtx } from "../pi.ts";
import type { Deps } from "../deps.ts";

/**
 * The last step: a message written by an agent, a commit performed by us.
 *
 * The split is the whole safety story - see `src/git.ts`. What the user is shown
 * before answering is the diffstat and the message, because those are the two
 * things they would regret not having read.
 */
export async function submit(
	request: string,
	brief: string,
	approved: boolean,
	committer: Agent,
	ctx: CommandCtx,
	deps: Deps,
): Promise<void> {
	const { git } = deps;
	const dirty = await git.status(ctx.cwd);
	if (!dirty.ok || !dirty.value.trim()) {
		refuse(ctx, "build: nothing changed on disk, so there is nothing to commit", "warning");
		return;
	}

	const [stat, patch, added] = await Promise.all([git.diffStat(ctx.cwd), git.diff(ctx.cwd), git.untracked(ctx.cwd)]);
	const summary = [stat.ok ? stat.value.trim() : "", added.length ? `new files:\n${added.join("\n")}` : ""].filter(Boolean).join("\n\n");

	// On the floor with everything else `/build` spawns: the run's signal and
	// spawn put the committer within reach of esc and `/stop`, and its dots
	// above the prompt say it is working.
	const written = await watched(ctx, deps, {
		status: "writing the commit message…",
		dir: undefined,
		work: (live) =>
			deps.run(committer, commitPrompt(brief, patch.ok ? patch.value : "", added), {
				cwd: ctx.cwd,
				signal: live.signal,
				spawn: live.spawn,
				onEvent: live.onEvent,
			}),
	});
	const message = written.ok ? written.output.trim() : "";

	if (!message) {
		refuse(ctx, "build: no commit message was produced - the work is still in the working tree", "warning");
		return;
	}

	// The user edits the message before deciding, not after: a message they had
	// to fix afterwards means a rewritten commit.
	const edited = await ctx.ui.editor("Commit message - edit it, or empty it to skip the commit", message);
	const final = edited?.trim();
	if (!final) {
		refuse(ctx, "build: no commit - everything is still in the working tree", "info");
		return;
	}

	await makeCommit(branchName(request), final, summary, approved, ctx, deps);
}

/**
 * The second of the two stops, and the only act in this file that reaches
 * history.
 *
 * A branch of its own, always: the work lands somewhere the user can throw away
 * without touching what they had. Nothing is pushed - that is theirs to decide.
 */
async function makeCommit(
	branch: string,
	message: string,
	summary: string,
	approved: boolean,
	ctx: CommandCtx,
	deps: Deps,
): Promise<void> {
	const { git } = deps;
	const go = await ctx.ui.confirm(`Commit on ${branch}?`, `${summary}\n\n${firstLines(message, 6)}`);
	if (!go) {
		refuse(ctx, `build: no commit - the work is in the working tree, ${approved ? "audited" : "NOT audited"}`, "info");
		return;
	}

	const branched = await git.createBranch(ctx.cwd, branch);
	if (!branched.ok) {
		refuse(ctx, `build: could not create ${branch}: ${branched.error}`, "error");
		return;
	}

	const committed = await git.commitAll(ctx.cwd, message);
	if (!committed.ok) {
		refuse(ctx, `build: commit failed: ${committed.error}`, "error");
		return;
	}

	ctx.ui.notify(`committed ${committed.value} on ${branch} - nothing was pushed`, "info");
}

/** What the committer reads: the specification, then the diff itself. */
export function commitPrompt(brief: string, patch: string, added: readonly string[]): string {
	return [
		"Write the commit message for the change below.",
		"",
		"What was asked for:",
		brief.trim(),
		"",
		added.length ? `New files:\n${added.join("\n")}\n` : "",
		"The diff:",
		patch.trim() || "(no tracked changes - the change is entirely in the new files above)",
	]
		.filter(Boolean)
		.join("\n");
}
