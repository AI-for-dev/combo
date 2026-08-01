/**
 * An interview, in a plain terminal - no pi, no TUI.
 *
 *   node examples/10-interview.ts "add a cache to the parser"
 *
 * This is the point of the `AskUser` port: the same `interview()` that the pi
 * extension drives with a select card runs here on `readline`. Swap the port,
 * keep the workflow.
 *
 * Answer with a number, type anything else to answer freely, or press enter on
 * an empty line to submit - that last one is the "that's enough, build it" of
 * the real UI.
 */

import * as readline from "node:readline/promises";
import { interview, type AskUser } from "../src/index.ts";
import { agent, consoleReporter, positional, repoRoot, show } from "./shared.ts";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask: AskUser = async (question) => {
	console.log(`\n\x1b[1m${question.header ? `[${question.header}] ` : ""}${question.question}\x1b[0m`);
	for (const [index, choice] of question.options.entries()) {
		console.log(`  ${index + 1}. ${choice.label}${choice.description ? ` - ${choice.description}` : ""}`);
	}
	console.log("  (enter alone = that's enough, build it)");

	// A closed stdin - piping the answers in, or Ctrl+D - reads as a submit
	// rather than as a crash: there is simply nothing more the user wants to say.
	let typed: string;
	try {
		typed = (await rl.question("> ")).trim();
	} catch {
		return undefined;
	}
	if (!typed) return undefined;

	const picked = question.options[Number(typed) - 1];
	return picked
		? { question: question.question, answer: picked.label, custom: false }
		: { question: question.question, answer: typed, custom: true };
};

const request = positional.join(" ") || "Add a cache in front of the agent loader";

try {
	const result = await interview({
		agent: agent("interviewer"),
		input: request,
		ask,
		maxQuestions: 4,
		cwd: repoRoot,
		onEvent: consoleReporter(),
	});

	show(result.submitted ? "brief (submitted early)" : "brief", result.ok ? result.brief : (result.error ?? "unknown"));
	console.log(`${result.answers.length} answer(s), ${result.usage.turns} turns, ${(result.usage.busyMs / 1000).toFixed(1)}s`);
} finally {
	rl.close();
}
