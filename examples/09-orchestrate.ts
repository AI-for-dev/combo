/**
 * Orchestration: an agent decides the split, then the split runs.
 *
 *   node examples/09-orchestrate.ts
 *
 * The difference with `03-fan-out.ts` is that nobody wrote the subtasks here.
 * What to check: the plan the planner produced (printed first), and that every
 * subtask reads as self-contained - the agent receiving one sees it and nothing
 * else, not the original request and not its siblings.
 *
 * This is also where the parsing decision shows: the planner is asked for JSON,
 * and `parsePlan` accepts what models actually send back - fenced, wrapped in
 * prose, or one `agent: task` line at a time. A step naming an agent that does
 * not exist is dropped, never remapped onto a plausible neighbour.
 */

import { formatUsage, orchestrate } from "../src/index.ts";
import { agent, consoleReporter, repoRoot, show } from "./shared.ts";

const result = await orchestrate({
	planner: agent("planner"),
	workers: [agent("scout"), agent("reviewer")],
	input: "Explain how this library measures what a subagent costs, and whether the numbers can be trusted.",
	reduceWith: agent("synthesiser"),
	maxTasks: 3,
	concurrency: 3,
	cwd: repoRoot,
	onEvent: consoleReporter(),
});

show("plan", result.plan.map((step, index) => `${index + 1}. ${step.agent.name}: ${step.task}`).join("\n") || "(none)");

if (result.answer) show("answer", result.answer.output);
else for (const [index, one] of result.results.entries()) show(`subtask ${index + 1}`, one.ok ? one.output : (one.error ?? "unknown"));

if (!result.ok) console.log(`not ok: ${result.error}`);
console.log(`total  ${formatUsage(result.usage)}`);
