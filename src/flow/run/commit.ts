/**
 * One visit of a `commit` node: the message an earlier node wrote, committed
 * by our code on the run's own branch.
 *
 * The model wrote a text; the act is here, through the `git` port, which has
 * no push. The run owns one branch, opened by its first commit and held to by
 * every later one: a later commit finding `HEAD` elsewhere refuses rather
 * than committing onto somebody else's branch.
 */

import type { GitPort } from "../../git/index.ts";
import { emptyUsage } from "../../usage.ts";
import type { CheckedCommitNode } from "../checked.ts";
import { failure, type Visited } from "./ended.ts";
import type { Journal } from "./journal.ts";
import type { Here } from "./walk.ts";

/** How a commit ended: made, or not on a clean tree, on the run's branch; or refused by git. */
export type CommitOutcome =
	| { readonly ok: true; readonly committed: boolean; readonly sha?: string; readonly branch: string }
	| { readonly ok: false; readonly kind: "unavailable"; readonly message: string };

/** What a commit visit needs from the run around it. */
export type CommittingRun = {
	/** Commits the working tree with `message`, for the visit `path` of `node`. */
	commit(node: CheckedCommitNode, path: string, message: string): Promise<CommitOutcome>;
};

/** Visits `node` at `path`. A message that is empty, or absent, fails before git is asked anything. */
export async function visitCommit(run: CommittingRun, node: CheckedCommitNode, path: string, here: Here): Promise<Visited> {
	const usage = emptyUsage();
	const reading = here.values.read(node.message);
	if (reading.kind === "failed") return { ended: failure("condition", `\`commit: ${node.message}\`: \`${node.message.split(".")[0]}\` failed`), usage };
	const message = reading.kind === "value" ? String(reading.value).trim() : "";
	if (message === "") return { ended: failure("empty-message", `\`${node.message}\` is empty: there is no message to commit with`), usage };
	const outcome = await run.commit(node, path, message);
	if (!outcome.ok) return { ended: failure(outcome.kind, outcome.message), usage };
	const { ok: _, ...output } = outcome;
	return { ended: { ok: true, output }, usage };
}

/**
 * The commits of one real run, in `cwd`: the first opens the run's branch,
 * `combo/<slug of input>`, written to `journal`, and each later one checks
 * `HEAD` is still on it.
 */
export function committer(git: GitPort, cwd: string, input: unknown, journal: Journal): (message: string) => Promise<CommitOutcome> {
	let branch: string | undefined;
	const refused = (message: string): CommitOutcome => ({ ok: false, kind: "unavailable", message });
	return async (message) => {
		if (branch === undefined) {
			const opened = await git.openBranch(cwd, typeof input === "string" ? input : JSON.stringify(input));
			if (!opened.ok) return refused(opened.error);
			branch = opened.value;
			journal.append({ type: "branch_opened", branch });
		} else {
			const current = await git.currentBranch(cwd);
			if (current !== branch) return refused(`\`HEAD\` is on ${current === undefined ? "no branch" : `\`${current}\``}, not on the run's branch: \`git switch ${branch}\``);
		}
		const made = await git.commit(cwd, message);
		if (!made.ok) return refused(made.error);
		return { ok: true, committed: made.value !== undefined, ...(made.value !== undefined && { sha: made.value }), branch };
	};
}
