/**
 * What the model sends the `subagent` tool: one schema, and the type is what it
 * says.
 *
 * pi is told the schema and validates the call against it, so a value it does
 * not name - a lifetime spelt differently, a scope nobody defined - is refused
 * before the tool body runs, and the body never has to check what pi already
 * did. Every field is optional: the mode is inferred from the others.
 */

import { Type, type Static } from "typebox";
import { LIFETIMES, MAX_DEPTH, type AgentScope } from "../src/index.ts";

/** The combinators the tool runs, by the name the model gives them, and `flow`, a flow a file describes. */
export const MODES = ["single", "chain", "parallel", "loop", "route", "orchestrate", "reduce", "flow"] as const;

/** One of {@link MODES}. */
export type Mode = (typeof MODES)[number];

const SCOPES = ["user", "project", "both"] as const satisfies readonly AgentScope[];

/** An optional field taking one of `values`: an `enum` for the model, the literal union for us. */
function oneOf<T extends string>(values: readonly T[], description: string) {
	return Type.Optional(Type.Unsafe<T>({ type: "string", enum: [...values], description }));
}

/**
 * The arguments the model sends, as pi is told them and as this file reads
 * them: one schema, and the type is what it says. Every field optional, the
 * mode inferred from the others.
 */
export const Schema = Type.Object({
	mode: oneOf(MODES, "Which combinator runs. Inferred from the other fields when omitted."),
	agent: Type.Optional(Type.String({ description: "Agent name, for single and parallel modes." })),
	flow: Type.Optional(
		Type.String({
			description: "Flow name, for flow mode: runs that flow on `task`. Takes only task, model, timeoutMs, scope and herdrAll beside it.",
		}),
	),
	task: Type.Optional(Type.String({ description: "The task, for single and chain and loop modes; the input, for flow mode." })),
	tasks: Type.Optional(Type.Array(Type.String(), { description: "Independent tasks to run in parallel." })),
	steps: Type.Optional(Type.Array(Type.String(), { description: "Agent names to run in order, for chain and loop." })),
	lifetime: oneOf(LIFETIMES, '"task" (default, fresh each time), "workflow" (subagents remember previous turns) or "session" (they outlive this call).'),
	model: Type.Optional(
		Type.String({
			description: 'Model for every subagent of this call, e.g. "anthropic/claude-sonnet-5". Beats agent frontmatter.',
		}),
	),
	concurrency: Type.Optional(Type.Number({ description: "Parallel branches at once. Default 4." })),
	until: Type.Optional(
		Type.String({
			description:
				'Loop stops when the last output says this word alone on a line, e.g. "LGTM". A line with anything else on it does not count.',
		}),
	),
	maxIterations: Type.Optional(Type.Number({ description: "Loop iteration cap. Default 5." })),
	maxTasks: Type.Optional(Type.Number({ description: "Most subtasks an orchestrate plan may contain. Default 8." })),
	maxDepth: Type.Optional(
		Type.Number({
			description: `How deep a subagent may delegate in turn. Default ${MAX_DEPTH}: a child and a grandchild.`,
		}),
	),
	candidates: Type.Optional(
		Type.Array(Type.String(), {
			description: "Agent names the router may pick from, or the planner may delegate to.",
		}),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Deadline per turn. No default; set it for long tasks." })),
	openInHerdr: Type.Optional(Type.Boolean({ description: "Give each subagent its own herdr split." })),
	scope: oneOf(SCOPES, '"user" (default), "project" or "both".'),
	reduceWith: Type.Optional(
		Type.String({ description: "Agent that synthesises the parallel results into one answer (reduce mode)." }),
	),
	herdrAll: Type.Optional(
		Type.Boolean({ description: "Give every subagent of this call its own herdr split, not only the ones that asked." }),
	),
	export: Type.Optional(
		Type.Boolean({
			description: "Write every subagent's transcript and a usage.json into runs/<timestamp>/.",
		}),
	),
});

/** {@link Schema}, as a type. Nothing is declared twice. */
export type Params = Static<typeof Schema>;

/** Infers the mode from what was actually provided. */
export function inferMode(params: Params): Mode {
	if (params.mode) return params.mode;
	if (params.flow !== undefined) return "flow";
	if (params.candidates) return "route";
	if (params.reduceWith) return "reduce";
	if (params.until || params.maxIterations) return "loop";
	if (params.steps?.length) return "chain";
	if (params.tasks?.length) return "parallel";
	return "single";
}
