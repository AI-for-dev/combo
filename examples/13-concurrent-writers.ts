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
 * Each coder works in a copy of the repository and hands back a patch. The
 * copies go when the coders are done, and `land` puts the patches into the tree
 * one at a time, so a conflict names the patch that caused it rather than
 * leaving you to bisect two. The shipped `build` flow does the same with
 * `copies: true`, a reviewer beside each coder; this is the part underneath.
 *
 * It stops before committing: what lands stays in the working tree for you to
 * read, exactly as `11-build.ts` leaves it.
 */

import * as path from "node:path";
import { formatUsage, isRepository, land, run, scratchWorktree } from "../src/index.ts";
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

const coder = agent("coder");

// A copy per subtask, made from HEAD and released once its coder is done:
// `release` takes the patch, commits it on the copy's branch, then removes the
// copy, so the work is kept even if the patch string were lost.
async function inCopy(input: string) {
	const copy = await scratchWorktree(cwd, input);
	if (!copy.ok) return { patch: "", error: copy.error };
	try {
		// pi's agent loop has no step cap; never run this unattended without one.
		const result = await run(coder, input, { cwd: copy.value.path, timeoutMs: 300_000, onEvent: consoleReporter() });
		const patch = await copy.value.release();
		return { result, branch: copy.value.branch, patch: patch.ok ? patch.value : "", error: patch.ok ? result.error : patch.error };
	} finally {
		await copy.value.release();
	}
}

const started = performance.now();
const results = await Promise.all(subtasks.map(inCopy));
const wall = performance.now() - started;

for (const [index, done] of results.entries()) {
	console.log(`\n──── subtask ${index + 1} ────`);
	console.log(`branch:   ${done.branch ?? "(none)"}`);
	console.log(`ok:       ${done.error === undefined ? "yes" : `no (${done.error})`}`);
	if (done.result) console.log(`usage:    ${formatUsage(done.result.usage)}`);
	console.log(done.patch ? `\n${done.patch.slice(0, 800)}` : "(it wrote nothing)");
}

console.log(`\nwall ${Math.round(wall)}ms for two coders, each in its own copy`);

// One at a time, so a conflict names the patch that caused it.
const landed = await land(
	cwd,
	results.map((done, index) => ({ label: `subtask ${index + 1}`, patch: done.patch })),
);

console.log(`\n──── landing ────`);
console.log(`applied:  ${landed.applied.join(", ") || "(nothing)"}`);
if (!landed.ok) console.log(`stopped:  ${landed.rejected ?? "(before anything)"} - ${landed.error}`);
console.log(
	landed.ok
		? "Both patches are in the working tree. Nothing was committed: read it, then decide."
		: "What landed is still in the tree, and the branches hold every patch. Nothing was undone.",
);
