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
 *
 * What it costs is a **tree**: the scouts are measured under the explorer that
 * asked for them, and the total at the bottom is the whole of it.
 */

import { combineReporters, createTuiCollector, delegateTool, run, summaryTable } from "../src/index.ts";
import { agent, agents, consoleReporter, positional, repoRoot } from "./shared.ts";

const question = positional.join(" ") || "How is a subagent's usage measured, and what is never estimated?";

const explorer = agent("explorer");
const collector = createTuiCollector();
const onEvent = combineReporters(consoleReporter(), collector.reporter);

const started = performance.now();
const result = await run(explorer, question, {
	cwd: repoRoot,
	onEvent,
	// pi's agent loop has no step cap; never run this unattended without one.
	timeoutMs: 300_000,
	// The roster the explorer may name and the depth it may not pass are decided
	// here: what an agent can reach is the caller's to say, and a tree that can
	// grow forever is a bill found afterwards. How **wide** it goes is the
	// agent's own, read from `concurrency:` in its file - hence `holder`.
	//
	// A function rather than a list, because the tool needs the id of the
	// subagent it is handed to, and `spawn` mints it: this is the first moment
	// anyone can know it, and without it the scouts read as roots.
	customTools: (parentId) => [
		delegateTool({ agents, holder: explorer, parentId, cwd: repoRoot, onEvent, timeoutMs: 300_000 }),
	],
});

console.log(`\n──── the answer ────\n${result.output}`);
if (!result.ok) console.log(`\nfailed: ${result.error}`);

console.log(`\n──── what it cost ────\n${summaryTable(collector.snapshot(), performance.now() - started).join("\n")}`);
