/**
 * Fan-out then reduce: N → 1.
 *
 *   node examples/07-reduce.ts
 *
 * Three scouts look at three different things; one synthesiser turns their
 * reports into a single answer. This is the shape most orchestration ends up
 * needing, and it is why `reduce` returns the branches in `steps`: the cost of
 * the answer is the cost of everything that produced it, not of the last turn.
 *
 * What to check: the synthesis answers the question rather than summarising
 * three reports one after the other.
 */

import { fanOut, formatUsage, reduce, sumUsage } from "../src/index.ts";
import { agent, consoleReporter, repoRoot, show } from "./shared.ts";

const question = "How does this library keep a subagent isolated from the user's environment?";

const startedAt = performance.now();
const { results } = await fanOut({
	agent: agent("scout"),
	tasks: [
		"Which tools does a subagent get by default, and where is that decided? Answer in three lines.",
		"How is a subagent's system prompt built, and what does it deliberately exclude? Answer in three lines.",
		"Where is the pi session created for a subagent? Answer in three lines.",
	],
	concurrency: 3,
	cwd: repoRoot,
	onEvent: consoleReporter(),
});

const answer = await reduce({
	agent: agent("synthesiser"),
	results,
	input: question,
	cwd: repoRoot,
	onEvent: consoleReporter(),
});

show("answer", answer.ok ? answer.output : (answer.error ?? "unknown"));

// The cost of the answer is the cost of everything that produced it.
const usage = sumUsage(
	answer.steps.map((step) => step.usage),
	performance.now() - startedAt,
);
console.log(`total  ${formatUsage(usage)}`);
