/**
 * The pipeline without the interview: a brief in, work reviewed and audited out,
 * and a commit message written from the real diff.
 *
 *   node examples/11-build.ts /path/to/a/throwaway/repo "add a slugify helper"
 *
 * **This one writes code.** It runs in the directory you give it, and that
 * directory must be a git repository you do not care about - an example must
 * never be able to rewrite the repository it ships in, which is why there is no
 * default and no fallback to the current directory.
 *
 * It stops short of committing: it prints the message the committer wrote and
 * leaves everything in the working tree. `/build` inside pi is what performs the
 * branch and the commit, after asking.
 */

import * as path from "node:path";
import { branchName, commandVerifier, deliver, diff, formatUsage, isRepository, run, status, untracked } from "../src/index.ts";
import { agent, consoleReporter, positional, show } from "./shared.ts";

const [target, ...words] = positional;
const brief = words.join(" ");

if (!target || !brief) {
	console.error('usage: node examples/11-build.ts [--model <pattern>] <throwaway-repo> "what to build"');
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

const built = await deliver({
	planner: agent("planner"),
	workers: [agent("coder")],
	reviewer: agent("reviewer"),
	auditor: agent("auditor"),
	brief,
	cwd,
	maxTasks: 2,
	maxRounds: 2,
	// The bar nobody can talk their way past. Without it, "approved" means two
	// agents read the code and liked it - which is how a test file importing
	// `./slugify.js` for `slugify.ts` once shipped as approved.
	verify: commandVerifier({ cwd, command: process.execPath, args: ["--test"] }),
	timeoutMs: 180_000,
	onEvent: consoleReporter(),
});

show("plan", built.plan.map((step, index) => `${index + 1}. ${step.agent.name}: ${step.task}`).join("\n") || "(none)");

for (const [index, task] of built.tasks.entries()) {
	show(`subtask ${index + 1} - ${task.approved ? "approved" : "NOT approved"} in ${task.rounds} round(s)`, task.output || (task.error ?? ""));
}

if (built.verification) {
	show(`check - ${built.verification.ok ? "passed" : "FAILED"} (${built.verification.command})`, built.verification.output);
}

for (const [index, audit] of built.audits.entries()) {
	show(`audit ${index + 1} - ${audit.approved ? "approved" : `${audit.fixes.length} fix(es)`}`, audit.review.output);
}

const dirty = await status(cwd);
if (!dirty.ok || !dirty.value.trim()) {
	console.log("nothing changed on disk");
	process.exit(built.ok ? 0 : 1);
}

// The agent writes the message; committing is the extension's job, after asking.
const patch = await diff(cwd);
const added = await untracked(cwd);
const message = await run(
	agent("committer"),
	[`What was asked for:\n${brief}`, added.length ? `New files:\n${added.join("\n")}` : "", `The diff:\n${patch.ok ? patch.value : ""}`]
		.filter(Boolean)
		.join("\n\n"),
	{ cwd, timeoutMs: 120_000 },
);

show("commit message (not committed)", message.output);
console.log(`would land on ${branchName(brief)}`);
console.log(`total  ${formatUsage(built.usage)}  ${built.approved ? "approved" : "NOT approved"}`);
