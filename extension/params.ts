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

/** Every mode but `flow`: what a field composing subagents is read by. */
const COMPOSED = MODES.filter((mode) => mode !== "flow");

/**
 * Which modes read each field beside `mode`: the descriptions a model reads
 * are written from it, and `flow` mode refuses what it does not list. Checked
 * against what the tool body actually reads, not trusted.
 */
const READS = {
	agent: ["single", "parallel", "route", "orchestrate", "reduce"],
	flow: ["flow"],
	task: MODES.filter((mode) => mode !== "parallel"),
	tasks: ["parallel", "reduce"],
	steps: ["chain", "loop"],
	lifetime: COMPOSED,
	model: MODES,
	concurrency: ["parallel", "orchestrate", "reduce"],
	until: ["loop"],
	maxIterations: ["loop"],
	maxTasks: ["orchestrate"],
	maxDepth: COMPOSED,
	candidates: ["route", "orchestrate"],
	timeoutMs: MODES,
	openInHerdr: COMPOSED,
	scope: MODES,
	reduceWith: ["orchestrate", "reduce"],
	herdrAll: MODES,
	export: COMPOSED,
} satisfies Record<string, readonly Mode[]>;

type Field = keyof typeof READS;

/** The modes that read `field`, as one type whatever row it is. */
const readers = (field: Field): readonly Mode[] => READS[field];

/** "Read by every mode", "every mode but X", or the modes named: the sentence that closes a description. */
function readBy(modes: readonly Mode[]): string {
	const missing = MODES.filter((mode) => !modes.includes(mode));
	if (missing.length === 0) return "Read by every mode.";
	if (missing.length === 1) return `Read by every mode but ${missing[0]}.`;
	const named = modes.length === 1 ? modes[0] : `${modes.slice(0, -1).join(", ")} and ${modes.at(-1)}`;
	return `Read by ${named}.`;
}

/** `text`, closed by the modes that read `field`. */
function describe(field: Field, text: string): string {
	return `${text} ${readBy(readers(field))}`;
}

/** An optional field taking one of `values`: an `enum` for the model, the literal union for us. */
function oneOf<T extends string>(values: readonly T[], description: string) {
	return Type.Optional(Type.Unsafe<T>({ type: "string", enum: [...values], description }));
}

/** Fields only orchestrate reads beside `candidates`: one of them given says an orchestration, not a route. */
const ORCHESTRATES = (Object.keys(READS) as Field[]).filter((field) => readers(field).includes("orchestrate") && !readers(field).includes("route"));
const ORCHESTRATES_TEXT = `${ORCHESTRATES.slice(0, -1).join(", ")} or ${ORCHESTRATES.at(-1)}`;

/**
 * The arguments the model sends, as pi is told them and as this file reads
 * them: one schema, and the type is what it says. Every field optional, the
 * mode inferred from the others.
 */
export const Schema = Type.Object({
	mode: oneOf(
		MODES,
		`Which combinator runs. Inferred when omitted, from the first of these given: flow; candidates (orchestrate beside ${ORCHESTRATES_TEXT}, route otherwise); reduceWith (reduce); until or maxIterations (loop); steps (chain); tasks (parallel); single otherwise.`,
	),
	agent: Type.Optional(Type.String({ description: describe("agent", "Agent name; the router for route, the planner for orchestrate.") })),
	flow: Type.Optional(Type.String({ description: describe("flow", "Flow name: runs that flow on `task`, and refuses every field it does not read.") })),
	task: Type.Optional(Type.String({ description: describe("task", "The task; the input of a flow, a route or an orchestration, the synthesis instruction of a reduce.") })),
	tasks: Type.Optional(Type.Array(Type.String(), { description: describe("tasks", "Independent tasks to run in parallel.") })),
	steps: Type.Optional(Type.Array(Type.String(), { description: describe("steps", "Agent names to run in order.") })),
	lifetime: oneOf(
		LIFETIMES,
		describe(
			"lifetime",
			'"task" (fresh each time), "workflow" (subagents remember previous turns) or "session" (they outlive this call). Omitted, the call names none and the workflow decides: "task" for an agent that declares no lifetime of its own.',
		),
	),
	model: Type.Optional(
		Type.String({ description: describe("model", 'Model for every subagent of this call, e.g. "anthropic/claude-sonnet-5". Beats agent frontmatter.') }),
	),
	concurrency: Type.Optional(Type.Number({ description: describe("concurrency", "Parallel branches at once. Default 4.") })),
	until: Type.Optional(
		Type.String({
			description: describe(
				"until",
				'Loop stops when the last output says this word alone on a line: "LGTM" for the shipped reviewer, "APPROVED" for the auditor, the words their definitions answer with. A line with anything else on it does not count.',
			),
		}),
	),
	maxIterations: Type.Optional(Type.Number({ description: describe("maxIterations", "Loop iteration cap. Default 5.") })),
	maxTasks: Type.Optional(Type.Number({ description: describe("maxTasks", "Most subtasks an orchestrate plan may contain. Default 8.") })),
	maxDepth: Type.Optional(
		Type.Number({ description: describe("maxDepth", `How deep a subagent may delegate in turn. Default ${MAX_DEPTH}: a child and a grandchild.`) }),
	),
	candidates: Type.Optional(
		Type.Array(Type.String(), {
			description: describe(
				"candidates",
				`Agent names the router may pick from, or the planner may delegate to. Infers route, or orchestrate beside ${ORCHESTRATES_TEXT}.`,
			),
		}),
	),
	timeoutMs: Type.Optional(Type.Number({ description: describe("timeoutMs", "Deadline per turn. No default; set it for long tasks.") })),
	openInHerdr: Type.Optional(Type.Boolean({ description: describe("openInHerdr", "Give each subagent its own herdr split.") })),
	scope: oneOf(SCOPES, describe("scope", '"user" (default), "project" or "both".')),
	reduceWith: Type.Optional(Type.String({ description: describe("reduceWith", "Agent that synthesises the results into one answer.") })),
	herdrAll: Type.Optional(
		Type.Boolean({ description: describe("herdrAll", "Give every subagent of this call its own herdr split, not only the ones that asked.") }),
	),
	export: Type.Optional(
		Type.Boolean({ description: describe("export", "Write every subagent's transcript and a usage.json into runs/<timestamp>/.") }),
	),
});

/** {@link Schema}, as a type. Nothing is declared twice. */
export type Params = Static<typeof Schema>;

/** The fields `flow` mode reads beside `flow` itself, in the order the schema lists them. */
export const FLOW_FIELDS = (Object.keys(READS) as Field[]).filter((field) => field !== "flow" && readers(field).includes("flow"));

// A field the schema gains is a field the table must place.
READS satisfies Record<Exclude<keyof Params, "mode">, readonly Mode[]>;

/**
 * Infers the mode from what was actually provided. `candidates` alone is a
 * route, the cheaper reading; beside a field only orchestrate reads, it is an
 * orchestration, since a route would drop that field without a word.
 */
export function inferMode(params: Params): Mode {
	if (params.mode) return params.mode;
	if (params.flow !== undefined) return "flow";
	if (params.candidates) return ORCHESTRATES.some((field) => params[field] !== undefined) ? "orchestrate" : "route";
	if (params.reduceWith) return "reduce";
	if (params.until || params.maxIterations) return "loop";
	if (params.steps?.length) return "chain";
	if (params.tasks?.length) return "parallel";
	return "single";
}

/**
 * Who a call in `mode` runs, from the field that mode reads: the flow, the
 * steps of a chain or a loop, or the agent, and the candidates when a router
 * or a planner is not named. Another field the model filled in beside them
 * is not what runs, so the row never names it.
 */
export function runsWho(params: Params, mode: Mode): string | undefined {
	if (mode === "flow") return params.flow;
	if (mode === "chain" || mode === "loop") return params.steps?.join(" → ");
	return params.agent ?? params.candidates?.join(", ");
}
