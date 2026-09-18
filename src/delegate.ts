/**
 * Letting a subagent have subagents of its own.
 *
 * An agent whose `tools:` names `subagent` is handed this, and can then split
 * its task across children of its own. Nothing else changes: the tool is built
 * here and passed through `SpawnOptions.customTools`, so `spawn` never learns
 * what a roster is.
 *
 * **This is a second exception to "a subagent inherits nothing".** The first is
 * `situate()`. Granting this is not inheritance either: the tool comes from
 * combo rather than from the user's machine, the roster is the one the caller
 * chose, and an agent that does not name it in its own file cannot have it. What
 * an agent can do stays readable in its definition, which is the part of the
 * invariant that was ever load-bearing.
 *
 * The depth guard ships with the feature rather than after it. Delegation that
 * can go on forever is a bill discovered afterwards, and the bound is carried in
 * a closure rather than read from anywhere: an ambient variable is how the model
 * hole in invariant 5 existed, and nothing here reads the environment.
 */

import { Type } from "typebox";
import type { Agent } from "./agent.ts";
import { defineTool, type ToolDefinition } from "./session.ts";
import { fanOut } from "./workflows/fan-out.ts";
import type { WorkflowOptions } from "./workflows/common.ts";

/** The name an agent writes in its `tools:` to be allowed children of its own. */
export const SUBAGENT_TOOL = "subagent";

/**
 * How deep delegation goes by default: the session, a child, a grandchild.
 *
 * Two is what pi-subagents settled on, and the reasoning carries: the second
 * level is where a split stops paying, because a grandchild rarely knows enough
 * about the whole to split anything usefully.
 */
export const MAX_DEPTH = 2;

/** Who a child may delegate to, how deep, and what its own children inherit. */
export type DelegateOptions = Omit<WorkflowOptions, "customTools" | "lifetime"> & {
	/** The roster a child may name. A name not on it is refused, never guessed. */
	agents: readonly Agent[];
	/** How many levels of delegation are allowed. Defaults to {@link MAX_DEPTH}. */
	maxDepth?: number;
	/** The depth of whoever is being handed this tool. The first call is 1. */
	depth?: number;
};

/** Whether an agent's definition asks to be allowed children of its own. */
export function declaresDelegate(tools: readonly string[] | undefined): boolean {
	return tools?.includes(SUBAGENT_TOOL) ?? false;
}

/**
 * Builds the `subagent` tool for an agent at a given depth.
 *
 * Pass it through `SpawnOptions.customTools`. An agent whose `tools:` does not
 * name `subagent` will not be given it by pi, so offering it costs nothing.
 *
 * At the bound the tool is still handed over and **refuses when called**, saying
 * how deep it is and how deep it may go. Withholding it instead would leave a
 * model calling a tool that does not exist, getting "unknown tool" back, and
 * trying again - which is the runaway turn `timeoutMs` exists to survive rather
 * than a thing to cause on purpose.
 */
export function delegateTool(options: DelegateOptions): ToolDefinition {
	const { agents, maxDepth = MAX_DEPTH, depth = 1, ...shared } = options;
	const roster = agents.map((one) => one.name).join(", ");

	return defineTool({
		name: SUBAGENT_TOOL,
		label: "Subagent",
		description:
			"Split your task across subagents that work in parallel and report back. " +
			`Each runs on its own, sees nothing of this conversation, and answers the task you give it. Available: ${roster}.`,
		promptSnippet: "Split your task across subagents that work in parallel",
		parameters: Type.Object({
			agent: Type.String({ description: `Which one does the work. One of: ${roster}.` }),
			tasks: Type.Array(Type.String(), {
				description: "One self-contained task per subagent. Each sees only its own, so repeat what it needs.",
			}),
		}),
		async execute(_toolCallId, params) {
			if (depth >= maxDepth) {
				return refuse(
					`You are ${depth} level(s) deep and ${maxDepth} is the limit. Do this part of the work yourself.`,
				);
			}

			const agent = agents.find((one) => one.name === params.agent);
			if (!agent) return refuse(`No subagent named "${params.agent}". Available: ${roster}.`);

			const tasks = params.tasks.map((task) => task.trim()).filter(Boolean);
			if (tasks.length === 0) return refuse("Give at least one task: a subagent with nothing to do costs a session.");

			const done = await fanOut({
				...shared,
				agent,
				tasks,
				// A child of a child gets the tool too, one level deeper, and only
				// when its own definition asks for it.
				customTools: (child) =>
					declaresDelegate(child.tools) ? [delegateTool({ ...options, depth: depth + 1 })] : undefined,
			});

			return {
				content: [{ type: "text" as const, text: report(done.results) }],
				details: undefined,
			};
		},
	});
}

/** A refusal the model can act on, rather than a failure it has to guess at. */
function refuse(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}

/** What comes back: each branch's answer, labelled, failures included. */
function report(results: readonly { agent: string; output: string; ok: boolean; error?: string }[]): string {
	return results
		.map((one, index) =>
			one.ok
				? `## ${index + 1}. ${one.agent}\n${one.output}`
				: `## ${index + 1}. ${one.agent} (failed)\n${one.error ?? "unknown error"}`,
		)
		.join("\n\n");
}
