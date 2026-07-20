/**
 * Reading a plan an agent wrote: the prompt, the parser, the validation.
 *
 * Split out from `orchestrate` because two combinators need a plan and only one
 * of them fans out over it: `deliver` runs a worker↔reviewer pair per subtask.
 *
 * The open question this file answers is **how to read what an agent decided**.
 * Three candidates were weighed: a tool call, structured output, or a parsed
 * convention. This is a parsed convention, and the reasoning is worth keeping:
 *
 * - **A tool call** is possible (`createAgentSession` takes `customTools`), and
 *   it would give validated arguments for free. It also means teaching
 *   `SessionPort` about tool definitions, and betting the whole thing on a model
 *   that reliably emits tool calls. The weak models this library is routinely
 *   run against do not.
 * - **Structured output** is not uniformly available across providers, and pi's
 *   `prompt()` returns text either way.
 * - **A parsed convention** costs one function, works on every provider, and the
 *   plan is validated against the known agents regardless - which is the check
 *   that actually matters. A schema would not have caught a hallucinated agent
 *   name; the name lookup does.
 *
 * {@link parsePlan} is therefore lenient, and *only* it: its input is a language
 * model, not a caller. Everywhere else in this library a malformed input is an
 * error.
 */

import type { Agent } from "./../agent.ts";
import { failed, type Result } from "./../result.ts";
import { SubagentPool, type WorkflowOptions } from "./common.ts";

/** One subtask an agent asked for. */
/** One step of a plan: a *resolved* agent - an unknown name never gets this far - and its task. */
export type PlannedTask = {
	/** Already resolved: an unknown name is dropped by the parser, never carried here. */
	agent: Agent;
	/** What that agent is asked to do, in the planner's own words. */
	task: string;
};

/** Who plans, who may be delegated to, and how large a plan may get. */
export type PlanOptions = WorkflowOptions & {
	/** The agent that decides the split. */
	planner: Agent;
	/** Who it may delegate to. Their `description` is what the planner reads. */
	workers: Agent[];
	/** What is to be split. The planner sees this and the roster, nothing else. */
	input: string;
	/**
	 * How many subtasks a plan may contain. Defaults to 8.
	 *
	 * Same reasoning as `loop`'s `maxIterations`: every subtask is a session and
	 * a bill, so "a plan of two hundred steps" must not be reachable by a
	 * hallucination. Exceeding it fails **before** anything is spawned - losing
	 * a run costs less than paying for a runaway one.
	 */
	maxTasks?: number;
	/** Overrides how the plan is read. See {@link parsePlan}. */
	parse?: (output: string, workers: readonly Agent[]) => PlannedTask[];
	/** Overrides the question put to the planner. See {@link planningPrompt}. */
	format?: (input: string, workers: readonly Agent[], maxTasks: number) => string;
};

/** A validated plan, or the reason there is none - decided before anything is spawned. */
export type PlanOutcome = {
	/** What the planner asked for, after validation. Empty when nothing is runnable. */
	plan: PlannedTask[];
	/** The planner's own turn. Kept whatever happened next. */
	planning: Result;
	/** False when the planner failed, or produced nothing runnable. */
	ok: boolean;
	/** Set if and only if `ok` is false. It carries what the planner actually wrote. */
	error?: string;
};

/**
 * Asks an agent how to split the work, and validates what comes back.
 *
 * Nothing is spawned beyond the planner itself: a plan is checked in full -
 * every agent name known, the cap respected - **before** any of it runs.
 * A step naming an unknown agent is dropped, never remapped: guessing which
 * agent a hallucinated name meant is how a workflow silently does the wrong
 * work.
 */
export async function makePlan(options: PlanOptions): Promise<PlanOutcome> {
	const { planner, workers, input, signal, timeoutMs } = options;
	if (workers.length === 0) throw new Error("makePlan: `workers` is empty - there is nobody to delegate to");

	const maxTasks = options.maxTasks ?? 8;
	const parse = options.parse ?? parsePlan;
	const format = options.format ?? planningPrompt;

	if (signal?.aborted) {
		const aborted = failed(planner.name, "aborted");
		return { plan: [], planning: aborted, ok: false, error: aborted.error };
	}

	// The planner gets its own pool: it is not one of the workers, and its
	// context has no business being reused by them.
	const pool = new SubagentPool(options);
	let planning: Result;
	try {
		const subagent = await pool.acquire(planner, planner.name);
		try {
			planning = await subagent.ask(format(input, workers, maxTasks), { signal, timeoutMs });
		} finally {
			await pool.release(subagent);
		}
	} finally {
		await pool.closeAll();
	}

	if (!planning.ok) return { plan: [], planning, ok: false, error: planning.error };

	const plan = parse(planning.output, workers);
	if (plan.length === 0) {
		return { plan: [], planning, ok: false, error: `no runnable plan: the planner answered ${JSON.stringify(preview(planning.output))}` };
	}
	if (plan.length > maxTasks) {
		return {
			plan: [],
			planning,
			ok: false,
			error: `plan of ${plan.length} subtasks exceeds maxTasks (${maxTasks}): nothing was spawned`,
		};
	}

	return { plan, planning, ok: true };
}

/** The question put to the planner: who is available, and how to answer. */
export function planningPrompt(input: string, workers: readonly Agent[], maxTasks: number): string {
	const menu = workers.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
	return [
		`Split the following work into at most ${maxTasks} independent subtasks, and assign each one to an agent.`,
		"Independent means they can run in parallel: no subtask may depend on another one's result.",
		"",
		"Available agents:",
		menu,
		"",
		'Answer with a JSON array only: [{"agent": "name", "task": "what to do"}]',
		"Keep the array even for a single subtask. No prose, no code fence, no explanation.",
		"",
		"Work:",
		input.trim(),
	].join("\n");
}

/**
 * Reads a plan out of whatever the planner actually wrote.
 *
 * Lenient by design - the input is a model. Two shapes are accepted, because
 * both are what models really produce when asked for the first:
 *
 * - **any JSON objects carrying `agent` and `task`**, in the order they appear:
 *   inside an array, alone, one per line, wrapped in a code fence or in prose.
 *   Asked for an array, a real planner answered with bare objects and no
 *   brackets - so the parser collects objects rather than requiring the shape;
 * - one subtask per line, `agent: task`.
 *
 * A step naming an unknown agent is **dropped**, never remapped: guessing which
 * agent a hallucinated name meant is how a workflow silently does the wrong
 * work. An empty result means "nothing usable was said", which the caller
 * reports rather than papers over.
 */
export function parsePlan(output: string, workers: readonly Agent[]): PlannedTask[] {
	const byName = new Map(workers.map((agent) => [agent.name.toLowerCase(), agent]));
	const steps = parseJsonPlan(output) ?? parseLinePlan(output);

	const plan: PlannedTask[] = [];
	for (const step of steps) {
		const agent = byName.get(step.agent.trim().toLowerCase());
		const task = step.task.trim();
		if (agent && task) plan.push({ agent, task });
	}
	return plan;
}

type RawStep = { agent: string; task: string };

/**
 * Every `{…}` block in the text that parses as a step, in order.
 *
 * Scanning for balanced braces rather than matching the whole answer is what
 * makes the array optional: an array, a bare object, several objects on their
 * own lines and a fenced block all reduce to the same thing here.
 */
function parseJsonPlan(output: string): RawStep[] | undefined {
	const steps: RawStep[] = [];

	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < output.length; i++) {
		const char = output[i];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') inString = true;
		else if (char === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (char === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				const step = readStep(output.slice(start, i + 1));
				if (step) steps.push(step);
				start = -1;
			}
		}
	}

	return steps.length > 0 ? steps : undefined;
}

/** One JSON object, kept only if it really carries a step. */
function readStep(text: string): RawStep | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	const step = parsed as { agent?: unknown; task?: unknown };
	if (typeof step?.agent !== "string" || typeof step?.task !== "string") return undefined;
	return { agent: step.agent, task: step.task };
}

/** `agent: task`, one per line, with the usual list decorations forgiven. */
function parseLinePlan(output: string): RawStep[] {
	const steps: RawStep[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim();
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		steps.push({ agent: line.slice(0, colon), task: line.slice(colon + 1) });
	}
	return steps;
}

function preview(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
