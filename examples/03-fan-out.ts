/**
 * A fan-out: three independent questions, two at a time.
 *
 *   node examples/03-fan-out.ts
 *
 * What to check: `busyMs` exceeds `wallMs`. That is the observable signature
 * of real parallelism - three branches worked, but not one after the other.
 */

import { fanOut, formatUsage } from "../src/index.ts";
import { agent, consoleReporter, repoRoot, show } from "./shared.ts";

const tasks = [
	"How is the lifetime of a subagent chosen? Answer in two lines.",
	"How is per-turn usage computed, and why is it a delta? Answer in two lines.",
	"How does a reporter subscribe to subagent events? Answer in two lines.",
];

const { results, usage } = await fanOut({
	agent: agent("scout"),
	tasks,
	concurrency: 2,
	cwd: repoRoot,
	onEvent: consoleReporter(),
});

for (const [index, result] of results.entries()) {
	show(`branch ${index + 1}${result.ok ? "" : " (failed)"}`, result.ok ? result.output : (result.error ?? "unknown"));
}

console.log(`total  ${formatUsage(usage)}`);
console.log(`wall ${usage.wallMs.toFixed(0)}ms for ${usage.busyMs.toFixed(0)}ms of work`);
console.log(`parallelism: ×${(usage.busyMs / usage.wallMs).toFixed(2)}`);
