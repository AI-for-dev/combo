/**
 * `orchestrate`: 1 → ?. An agent *decides* the split, then the split runs.
 *
 * The open question here was never the plumbing - it was **how to read what the
 * agent decided**. Three candidates: a tool call, structured output, or a parsed
 * convention. This is a parsed convention, and the reasoning is worth keeping:
 *
 * - **A tool call** is possible (`createAgentSession` takes `customTools`), and
 *   it would give validated arguments for free. It also means teaching
 *   `SessionPort` about tool definitions, and betting the whole combinator on a
 *   model that reliably emits tool calls. The weak models this library is
 *   routinely run against do not.
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
import { sumUsage, type Usage } from "./../usage.ts";
import { SubagentPool, type WorkflowOptions } from "./common.ts";
import { fanOut } from "./fan-out.ts";
import { reduce } from "./reduce.ts";

/** One subtask the planner asked for. */
export type PlannedTask = { agent: Agent; task: string };

export type OrchestrateOptions = WorkflowOptions & {
	/** The agent that decides the split. */
	planner: Agent;
	/** Who it may delegate to. Their `description` is what the planner reads. */
	workers: Agent[];
	input: string;
	/** Subtasks in flight at once, as in {@link fanOut}. Defaults to 4. */
	concurrency?: number;
	/**
	 * How many subtasks a plan may contain. Defaults to 8.
	 *
	 * Same reasoning as `loop`'s `maxIterations`: every subtask is a session and
	 * a bill, so "a plan of two hundred steps" must not be reachable by a
	 * hallucination. Exceeding it fails **before** anything is spawned - losing
	 * a run costs less than paying for a runaway one.
	 */
	maxTasks?: number;
	/** When given, this agent turns the subtask results into one answer. */
	reduceWith?: Agent;
	/** Overrides how the plan is read. See {@link parsePlan}. */
	parse?: (output: string, workers: readonly Agent[]) => PlannedTask[];
	/** Overrides the question put to the planner. See {@link planningPrompt}. */
	format?: (input: string, workers: readonly Agent[], maxTasks: number) => string;
};

export type OrchestrateResult = {
	/** What the planner asked for, after validation. Empty when planning failed. */
	plan: PlannedTask[];
	/** The planner's own turn. Kept whatever happened next. */
	planning: Result;
	/** One result per planned subtask, in plan order. */
	results: Result[];
	/** The synthesis, present only when `reduceWith` was given. */
	answer?: Result;
	/** Aggregate over planning, subtasks and synthesis. `wallMs` is the whole run. */
	usage: Usage;
	/** False when the planning failed or produced nothing runnable. */
	ok: boolean;
	error?: string;
};

/**
 * Asks an agent to split the work, then runs the split it asked for.
 *
 * This is a **dynamic** fan-out: unlike {@link fanOut}, nobody wrote the tasks
 * in advance. Everything else is the same machinery - bounded concurrency, one
 * subagent per branch, no shared state - because a plan the model wrote deserves
 * no more trust than a plan the caller wrote, and a good deal less latitude.
 *
 * A plan naming an unknown agent is dropped, not guessed at; a plan with nothing
 * usable left in it is `ok: false` with the planner's answer to look at. Nothing
 * is spawned before the whole plan has been validated.
 */
export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
	// The rest **is** the WorkflowOptions the sub-workflows take: destructuring
	// this way means a new common option reaches them without a line of code
	// here, and this combinator's own options never leak into them.
	const { planner, workers, input, concurrency, maxTasks: cap, reduceWith, parse: readPlan, format: ask, ...shared } = options;
	const { signal, timeoutMs } = shared;
	if (workers.length === 0) throw new Error("orchestrate: `workers` is empty - there is nobody to delegate to");

	const maxTasks = cap ?? 8;
	const parse = readPlan ?? parsePlan;
	const format = ask ?? planningPrompt;
	const startedAt = performance.now();

	const done = (planning: Result, plan: PlannedTask[], results: Result[], answer?: Result): OrchestrateResult => {
		const usages = [planning.usage, ...results.map((result) => result.usage)];
		if (answer) usages.push(answer.usage);
		const failedStep = [...results, answer].find((result) => result && !result.ok);
		return {
			plan,
			planning,
			results,
			answer,
			usage: sumUsage(usages, performance.now() - startedAt),
			ok: planning.ok && plan.length > 0 && !failedStep,
			error: planning.ok ? failedStep?.error : planning.error,
		};
	};

	if (signal?.aborted) {
		const aborted = failed(planner.name, "aborted");
		return done(aborted, [], []);
	}

	// The planner is spawned on its own pool: it is not one of the workers, and
	// its context has no business being reused by them.
	const pool = new SubagentPool(shared);
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

	if (!planning.ok) return done(planning, [], []);

	const plan = parse(planning.output, workers);
	if (plan.length === 0) {
		return {
			...done(planning, [], []),
			ok: false,
			error: `no runnable plan: the planner answered ${JSON.stringify(preview(planning.output))}`,
		};
	}
	if (plan.length > maxTasks) {
		return {
			...done(planning, [], []),
			plan: [],
			ok: false,
			error: `plan of ${plan.length} subtasks exceeds maxTasks (${maxTasks}): nothing was spawned`,
		};
	}

	const { results } = await fanOut({
		...shared,
		concurrency,
		agents: plan.map((step) => step.agent),
		tasks: plan.map((step) => step.task),
	});

	if (!reduceWith) return done(planning, plan, results);

	const answer = await reduce({ ...shared, agent: reduceWith, results, input });
	return done(planning, plan, results, answer);
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
