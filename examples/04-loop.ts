/**
 * The coding ↔ review loop - the workflow this library exists for.
 *
 *   node examples/04-loop.ts
 *
 * Two parts, because they answer two different questions:
 *
 * 1. Convergence: does the judge stop the loop? Watch `converged` - running out
 *    of iterations is not success.
 * 2. Lifetime: `"workflow"` keeps the same reviewer across iterations (it will
 *    not repeat a remark it already made), `"task"` gives every iteration a
 *    reviewer that has never seen the code. Part 2 pins the iteration count so
 *    the difference is always visible; with a judge in the loop, a run that
 *    converges immediately would show the same count for both.
 */

import { aggregate, formatUsage, loop, READ_ONLY_TOOLS, type Lifetime, type SubagentEvent } from "../src/index.ts";
import { agent, consoleReporter, repoRoot, show } from "./shared.ts";

/**
 * The coder runs read-only here, and that is not decoration.
 *
 * An earlier version of this example only *asked* the coder not to edit
 * anything. It edited `src/usage.ts` anyway, twice. A prompt is a request; the
 * tool allowlist is the boundary. An example shipped in a repository must not
 * be able to rewrite that repository.
 */
const readOnlyCoder = { ...agent("coder"), tools: [...READ_ONLY_TOOLS] };

const steps = [readOnlyCoder, agent("reviewer")];
const input = [
	"In src/usage.ts, review formatUsage and its compact/trim helpers.",
	"Describe the change you would make, then hand it to the reviewer.",
].join(" ");

/** Counts spawns without the workflow knowing a reporter exists. */
function watch() {
	const report = consoleReporter();
	let spawns = 0;
	const onEvent = (event: SubagentEvent) => {
		if (event.type === "spawn") spawns++;
		report(event);
	};
	return { onEvent, spawns: () => spawns };
}

// ── Part 1: does the judge stop the loop? ────────────────────────────────────

console.log("\n══════ 1. convergence (until: LGTM) ══════");
const watcher = watch();
const startedAt = performance.now();

const converge = await loop({
	steps,
	input,
	lifetime: "workflow",
	until: (step) => step.output.includes("LGTM"),
	maxIterations: 3,
	// pi's agent loop has no step cap; never run this unattended without one.
	timeoutMs: 120_000,
	cwd: repoRoot,
	onEvent: watcher.onEvent,
});

show("verdict", converge.ok ? converge.output : (converge.error ?? "unknown error"));
console.log(
	converge.converged
		? `converged after ${converge.iterations} iteration(s)`
		: `NOT converged - ran out after ${converge.iterations} iteration(s)`,
);
// `converge.usage` is the last turn only. The loop as a whole is the sum of its
// steps, over the time it really took.
console.log(`loop total  ${formatUsage(aggregate(converge.steps, performance.now() - startedAt))}`);

// ── Part 2: what lifetime actually changes ───────────────────────────────────

async function countSpawns(lifetime: Lifetime) {
	console.log(`\n══════ 2. lifetime: ${lifetime} (2 fixed iterations) ══════`);
	const observer = watch();

	// No `until`: two iterations, always, so the comparison below is meaningful.
	await loop({ steps, input, lifetime, maxIterations: 2, timeoutMs: 120_000, cwd: repoRoot, onEvent: observer.onEvent });
	return observer.spawns();
}

const asWorkflow = await countSpawns("workflow");
const asTask = await countSpawns("task");

console.log(`\n2 iterations × 2 agents:`);
console.log(`  "workflow" → ${asWorkflow} subagents (one per agent, reused across iterations)`);
console.log(`  "task"     → ${asTask} subagents (a fresh one every iteration)`);
