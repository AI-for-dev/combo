/**
 * Letting a subagent have subagents of its own.
 *
 * An agent whose `tools:` names `subagent` is handed this, and can then split
 * its task across children of its own. Nothing else changes: the tool is built
 * here and passed through `SpawnOptions.customTools`, so `spawn` never learns
 * what a roster is.
 *
 * **This is one of the three exceptions to "a subagent inherits nothing"**,
 * beside `situate()` and `skills:`. Granting it is not inheritance either: the
 * tool comes from combo rather than from the user's machine, the roster is the
 * one the caller chose, and an agent that does not name it in its own file
 * cannot have it. What an agent can do stays readable in its definition, which
 * is the part of the invariant that was ever load-bearing.
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
 * Two is where a split stops paying. A grandchild has been handed one slice of
 * one slice, and rarely knows enough about the whole to divide it usefully - it
 * spends a turn deciding that instead of reading.
 */
export const MAX_DEPTH = 2;

/** Who a child may delegate to, how deep, and what its own children inherit. */
export type DelegateOptions = Omit<WorkflowOptions, "customTools" | "lifetime"> & {
	/** Branches at once, when the holder's definition does not say. */
	concurrency?: number;
	/** The roster a child may name. A name not on it is refused, never guessed. */
	agents: readonly Agent[];
	/**
	 * The agent being handed this tool.
	 *
	 * Its `concurrency:` decides how many children it runs at once. Passing it is
	 * what lets that number live in the agent's own file rather than in every
	 * call site, and a child that delegates in turn is read the same way.
	 */
	holder?: Agent;
	/** How many levels of delegation are allowed. Defaults to {@link MAX_DEPTH}. */
	maxDepth?: number;
	/** The depth of whoever is being handed this tool. The first call is 1. */
	depth?: number;
	/**
	 * The id of the subagent holding this tool, so its children can name it.
	 *
	 * Absent at the top level only when nobody could say: the holder's id is
	 * minted by `spawn`, so a caller building this tool by hand takes it from
	 * `SpawnOptions.customTools` in its function form. Without it the children
	 * are still spawned and still measured - they simply read as roots, which
	 * is a measurement that has lost a fact rather than a run that failed.
	 */
	parentId?: string;
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
	const { agents, holder, maxDepth = MAX_DEPTH, depth = 1, parentId, ...shared } = options;
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
				// Every child of this call hangs under whoever called the tool.
				// This is the only place the tree is built: nothing infers a
				// parent afterwards, and nothing reads a name to guess one.
				parentId,
				// The delegator's own number, not the one it is delegating to: how
				// wide a split is worth making is a fact about the agent doing the
				// splitting. Absent, `fanOut` decides.
				concurrency: holder?.concurrency ?? shared.concurrency,
				// A child of a child gets the tool too, one level deeper, and only
				// when its own definition asks for it. Built from the child's own
				// id, which exists one step later than everything else here: a
				// grandchild hangs under the child, not under this holder.
				customTools: (child) =>
					declaresDelegate(child.tools)
						? (childId: string) => [
								delegateTool({ ...options, holder: child, parentId: childId, depth: depth + 1 }),
							]
						: undefined,
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
