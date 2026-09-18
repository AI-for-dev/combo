/**
 * A subagent with subagents of its own: one explorer, three scouts, one answer.
 *
 *   node examples/14-delegation-tree.ts [--model <pattern>] "how is usage measured?"
 *
 * The explorer cannot read this repository in one turn, so it splits the reading
 * and gives one task per part. Each scout sees only its own task. What comes
 * back is one note, not three.
 *
 * The tool reaches the explorer through `SpawnOptions.customTools`, and only
 * because `agents/explorer.md` names `subagent` in its `tools:`. An agent that
 * does not name it cannot spawn anything, and that fact is readable in its file.
 */

import { delegateTool, formatUsage, run } from "../src/index.ts";
import { agent, agents, consoleReporter, positional, repoRoot } from "./shared.ts";

const question = positional.join(" ") || "How is a subagent's usage measured, and what is never estimated?";

const explorer = agent("explorer");
const onEvent = consoleReporter();

const result = await run(explorer, question, {
	cwd: repoRoot,
	onEvent,
	// pi's agent loop has no step cap; never run this unattended without one.
	timeoutMs: 300_000,
	// The roster the explorer may name, and the depth it may not pass. Both are
	// decided here rather than by the agent: what it can reach is the caller's
	// to say, and a tree that can grow forever is a bill found afterwards.
	customTools: [delegateTool({ agents, cwd: repoRoot, onEvent, timeoutMs: 300_000 })],
});

console.log(`\n──── the answer ────\n${result.output}`);
console.log(`\n${result.ok ? "" : `failed: ${result.error}\n`}explorer: ${formatUsage(result.usage)}`);
console.log("The scouts' own usage is on their rows above: a tree is not one number yet.");
