/**
 * The coding ↔ review loop, run twice: as a team, then with fresh eyes.
 *
 *   node examples/04-loop.ts
 *
 * This is the workflow the library exists for, and the one where lifetime
 * stops being a detail. Count the `spawn` lines: `"workflow"` keeps the same
 * reviewer across iterations - it will not repeat a remark it already made -
 * while `"task"` gives every iteration a reviewer that has never seen the code.
 *
 * Watch `converged` too: running out of iterations is not success.
 */

import { formatUsage, loop, type Lifetime, type SubagentEvent } from "../src/index.ts";
import { agent, consoleReporter, repoRoot, show } from "./shared.ts";

const steps = [agent("coder"), agent("reviewer")];
const input = [
	"In src/usage.ts, review formatUsage and its compact/trim helpers.",
	"Do not change any file: describe the change you would make, then hand it to the reviewer.",
].join(" ");

async function runWith(lifetime: Lifetime) {
	let spawns = 0;
	const report = consoleReporter();
	const onEvent = (event: SubagentEvent) => {
		if (event.type === "spawn") spawns++;
		report(event);
	};

	console.log(`\n══════ lifetime: ${lifetime} ══════`);
	const result = await loop({
		steps,
		input,
		lifetime,
		until: (step) => step.output.includes("LGTM"),
		maxIterations: 3,
		// pi's agent loop has no step cap; never run this unattended without one.
		timeoutMs: 120_000,
		cwd: repoRoot,
		onEvent,
	});

	show(`loop (${lifetime})`, result.ok ? result.output : (result.error ?? "unknown error"));
	console.log(
		result.converged
			? `converged after ${result.iterations} iteration(s), ${spawns} subagents`
			: `NOT converged after ${result.iterations} iteration(s), ${spawns} subagents`,
	);
	console.log(formatUsage(result.usage));
	return spawns;
}

const asWorkflow = await runWith("workflow");
const asTask = await runWith("task");

console.log(`\n"workflow" spawned ${asWorkflow}, "task" spawned ${asTask} - one argument apart.`);
