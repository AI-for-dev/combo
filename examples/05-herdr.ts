/**
 * Watching subagents work, each in its own herdr split.
 *
 *   node examples/05-herdr.ts
 *
 * Run this from inside a herdr pane: three splits open, one per branch, and you
 * watch the three scouts search in parallel. They close on their own when they
 * finish.
 *
 * The point to notice is what is *not* here: the workflow below says nothing
 * about herdr beyond `openInHerdr`. `autoReporter()` picks herdr when it is
 * there and stays silent when it is not - the same code runs either way, which
 * is the whole promise of "display is an observer, never a participant".
 *
 * A herdr pane cannot host an in-process subagent: there is no process and no
 * TTY to attach. So the pane does not host it - it tails a file we write.
 */

import { autoReporter, consoleReporter, detectHerdr, fanOut, formatUsage } from "../src/index.ts";
import { agent, repoRoot, show } from "./shared.ts";

const inHerdr = detectHerdr() !== undefined;
console.log(
	inHerdr
		? "herdr detected - each subagent gets its own split"
		: "no herdr here - falling back to the console, nothing else changes",
);

const tasks = [
	"How is the lifetime of a subagent chosen? Answer in two lines.",
	"How does the herdr reporter give a subagent its own pane? Answer in two lines.",
	"Why is per-turn usage a delta rather than a total? Answer in two lines.",
];

const { results, usage } = await fanOut({
	agent: agent("scout"),
	tasks,
	concurrency: 3,
	// Opt-in, per subagent - a fan-out of twenty would not carpet the screen.
	openInHerdr: true,
	timeoutMs: 120_000,
	cwd: repoRoot,
	// In herdr: three splits. Outside: the console. Same line of code.
	onEvent: inHerdr ? autoReporter() : consoleReporter(),
});

for (const [index, result] of results.entries()) {
	show(`branch ${index + 1}${result.ok ? "" : " (failed)"}`, result.ok ? result.output : (result.error ?? "unknown"));
}

console.log(`total  ${formatUsage(usage)}`);
console.log(`parallelism: ×${(usage.busyMs / usage.wallMs).toFixed(2)}`);
