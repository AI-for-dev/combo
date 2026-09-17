/**
 * Two coders on two subtasks of one ticket, writing at the same time without
 * writing over each other.
 *
 *   node examples/13-concurrent-writers.ts /path/to/a/throwaway/repo
 *
 * **This one writes code.** It runs in the directory you give it, and that
 * directory must be a git repository you do not care about - an example must
 * never be able to rewrite the repository it ships in, which is why there is no
 * default and no fallback to the current directory.
 *
 * It stops at the patches. Each pair works in a copy of the repository, the copy
 * goes when the pair is done, and what comes back is a diff and the branch it
 * was made on. Deciding what to do with two patches is a policy, not a
 * mechanism, and it is not this example's business.
 */

import * as path from "node:path";
import { isRepository, pair, formatUsage } from "../src/index.ts";
import { agent, consoleReporter, positional } from "./shared.ts";

const [target] = positional;
if (!target) {
	console.error("usage: node examples/13-concurrent-writers.ts [--model <pattern>] <throwaway-repo>");
	process.exit(1);
}

const cwd = path.resolve(target);
if (cwd === path.resolve(import.meta.dirname, "..")) {
	console.error("refusing to run on this repository: point me at a throwaway one");
	process.exit(1);
}
if (!(await isRepository(cwd))) {
	console.error(`${cwd} is not a git repository`);
	process.exit(1);
}

// Disjoint on purpose: two files nobody else touches. That is the promise a
// planner makes and cannot keep on its own, and a copy each is what stops a
// broken promise from becoming two agents editing one line.
const subtasks = [
	"Add src/slugify.js exporting `slugify(text)`: lower case, non-alphanumerics to single dashes, no leading or trailing dash.",
	"Add src/truncate.js exporting `truncate(text, max)`: at most `max` characters, an ellipsis when it had to cut.",
];

const shared = {
	worker: agent("coder"),
	reviewer: agent("reviewer"),
	cwd,
	worktree: true,
	maxRounds: 2,
	// pi's agent loop has no step cap; never run this unattended without one.
	timeoutMs: 300_000,
	onEvent: consoleReporter(),
};

const started = performance.now();
const results = await Promise.all(subtasks.map((input) => pair({ ...shared, input })));
const wall = performance.now() - started;

for (const [index, result] of results.entries()) {
	console.log(`\n──── subtask ${index + 1} ────`);
	console.log(`branch:   ${result.worktree ?? "(none)"}`);
	console.log(`approved: ${result.approved}${result.ok ? "" : `  (failed: ${result.error})`}`);
	console.log(`usage:    ${formatUsage(result.usage)}`);

	const patch = result.patch ?? "";
	console.log(patch ? `\n${patch.slice(0, 1200)}` : "(it wrote nothing)");
}

console.log(`\nwall ${Math.round(wall)}ms for two pairs, each in its own copy`);
console.log("The repository you pointed at was not written to. The patches above are the work.");
