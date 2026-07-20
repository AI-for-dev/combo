/**
 * `route`: 1 → 1. A classifier agent picks who should do the work.
 */

import type { Agent } from "./../agent.ts";
import { failed, type Result, type WorkflowResult } from "./../result.ts";
import { SubagentPool, type WorkflowOptions } from "./common.ts";

/** The classifier, the agents it may pick from, and what to do when it picks nobody. */
export type RouteOptions = WorkflowOptions & {
	/** The agent that classifies. It sees the destinations, never the work. */
	router: Agent;
	/** Where the task may go. Their `description` is what the classifier reads. */
	destinations: Agent[];
	/** The work to route. The classifier is asked about it; only the destination does it. */
	input: string;
	/** Taken when the classifier names nothing recognisable. */
	fallback?: Agent;
	/** Overrides how the classifier's answer is read. See {@link pickDestination}. */
	parse?: (output: string, destinations: readonly Agent[]) => Agent | undefined;
	/** Overrides the question put to the classifier. See {@link routingPrompt}. */
	format?: (input: string, destinations: readonly Agent[]) => string;
};

/** The destination's result, plus who was picked and how. */
export type RouteResult = WorkflowResult & {
	/** Who was chosen, or `undefined` when nothing was. */
	destination?: Agent;
	/** The classifier's own turn, kept even when the routing failed. */
	routing: Result;
};

/**
 * Classifies a task, then hands it to the destination that was picked.
 *
 * The classifier reads the destinations' **descriptions** - the field pi already
 * makes mandatory - so routing needs no second vocabulary to maintain. Write a
 * description that says when to pick that agent and routing works; write a vague
 * one and no parser will save it.
 *
 * **An unroutable task is a `Result`, not a throw.** A classifier that answers
 * with prose, or names an agent that does not exist, is a model failure like any
 * other: with a `fallback` the work still happens, without one the caller gets
 * `ok: false` and the classifier's actual answer to look at. What never happens
 * is a silent pick of the first destination.
 */
export async function route(options: RouteOptions): Promise<RouteResult> {
	const { router, destinations, input, signal, timeoutMs } = options;
	if (destinations.length === 0) throw new Error("route: `destinations` is empty - there is nowhere to route to");

	const parse = options.parse ?? pickDestination;
	const format = options.format ?? routingPrompt;

	if (signal?.aborted) {
		const aborted = failed(router.name, "aborted");
		return { ...aborted, routing: aborted, steps: [aborted] };
	}

	const pool = new SubagentPool(options);
	try {
		const classifier = await pool.acquire(router, router.name);
		let routing: Result;
		try {
			routing = await classifier.ask(format(input, destinations), { signal, timeoutMs });
		} finally {
			await pool.release(classifier);
		}

		if (!routing.ok) return { ...routing, routing, steps: [routing] };

		const destination = parse(routing.output, destinations) ?? options.fallback;
		if (!destination) {
			const unrouted = failed(
				router.name,
				`no destination matched: the router answered ${JSON.stringify(truncate(routing.output))}`,
				routing.usage,
				routing.messages,
			);
			return { ...unrouted, routing, steps: [routing, unrouted] };
		}

		const worker = await pool.acquire(destination, destination.name);
		let handled: Result;
		try {
			handled = await worker.ask(input, { signal, timeoutMs });
		} finally {
			await pool.release(worker);
		}

		return { ...handled, destination, routing, steps: [routing, handled] };
	} finally {
		await pool.closeAll();
	}
}

/**
 * The question put to the classifier: the destinations, then the task.
 *
 * It asks for the name alone. That is a hint, not a contract - {@link
 * pickDestination} is what actually makes the answer usable.
 */
export function routingPrompt(input: string, destinations: readonly Agent[]): string {
	const menu = destinations.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
	return [
		"Route the following task to exactly one of these agents.",
		"",
		menu,
		"",
		"Answer with the agent name alone, nothing else.",
		"",
		"Task:",
		input.trim(),
	].join("\n");
}

/**
 * Reads a destination out of whatever the classifier actually wrote.
 *
 * The input here is a language model, not a caller, so this is lenient on
 * purpose - and only here. It tries, in order: the whole answer as a name, the
 * last non-empty line, then the first name mentioned anywhere. Matching is on
 * whole words, so `coder` never matches inside `decoder`.
 *
 * Ambiguity is refused rather than guessed: an answer naming two destinations
 * on its last line resolves to nothing, and the caller sees what was said.
 */
export function pickDestination(output: string, destinations: readonly Agent[]): Agent | undefined {
	const names = destinations.map((agent) => agent.name);
	const byName = (name: string) => destinations.find((agent) => agent.name === name);

	const answer = output.trim();
	const exact = byName(answer);
	if (exact) return exact;

	const lastLine = answer.split("\n").filter((line) => line.trim()).at(-1) ?? "";
	const onLastLine = mentioned(lastLine, names);
	if (onLastLine.length === 1) return byName(onLastLine[0] as string);

	const anywhere = mentioned(answer, names);
	return anywhere.length === 1 ? byName(anywhere[0] as string) : undefined;
}

/** The distinct names appearing as whole words in `text`. */
function mentioned(text: string, names: readonly string[]): string[] {
	return names.filter((name) => new RegExp(`(^|[^\\w-])${escapeRegExp(name)}($|[^\\w-])`, "i").test(text));
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
