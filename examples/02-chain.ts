/**
 * A chain, run twice: once fresh, once as a team.
 *
 *   node examples/02-chain.ts
 *
 * The two runs differ by a single argument, and by nothing else. Count the
 * `spawn` lines: `"task"` spawns one subagent per step, `"workflow"` one per
 * distinct agent. That difference *is* the lifetime.
 */

import { chain, formatUsage, type Lifetime, type SubagentEvent } from "../src/index.ts";
import { agent, consoleReporter, repoRoot, show } from "./shared.ts";

const steps = [agent("scout"), agent("reviewer"), agent("scout")];
const input = "Find how cancellation reaches a running turn, then judge whether it is airtight.";

async function runWith(lifetime: Lifetime) {
	let spawns = 0;
	const report = consoleReporter();
	const onEvent = (event: SubagentEvent) => {
		if (event.type === "spawn") spawns++;
		report(event);
	};

	console.log(`\n══════ lifetime: ${lifetime} ══════`);
	const result = await chain({ steps, input, lifetime, cwd: repoRoot, onEvent });

	show(`chain (${lifetime})`, result.ok ? result.output : (result.error ?? "unknown error"));
	console.log(`${spawns} subagents spawned for ${steps.length} steps`);
	return spawns;
}

const asTask = await runWith("task");
const asWorkflow = await runWith("workflow");

console.log(`\n"task" spawned ${asTask}, "workflow" spawned ${asWorkflow} - same workflow, one argument apart.`);
