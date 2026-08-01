/**
 * A pipeline is *data*: an ordered list of combinator calls, declared as YAML
 * frontmatter + Markdown, following the same convention as an agent.
 *
 * Frontmatter holds the **structure** - which combinator, which agents, which
 * guards - because `parseFrontmatter` is a real YAML parser and gives nesting
 * for free. The body holds the **prose**, one `## <id>` section per step: a
 * ten-line instruction in a `task: |` block scalar is indentation-sensitive and
 * miserable to write, and prose is the one thing Markdown is actually for.
 *
 * What a pipeline deliberately is **not**: a programming language. No `if`, no
 * `when`, no `${{ steps.x.output }}`. Steps are linear and each one receives the
 * previous one's output - that is the whole dataflow. The moment a run needs a
 * branch, it is a TypeScript workflow, not a file. That line is what keeps
 * "agents are data, workflows are code" true while still letting a pipeline be
 * written in Markdown.
 *
 * And the reason any of this exists: **no agent reads this file to decide what
 * happens next.** Our runner walks the steps. An agent that is handed a
 * sequence in prose skips a step and nobody notices; the two places where a
 * model still decides (`orchestrate`, `route`) are bounded and parsed already.
 *
 * This file turns text into data and validates it. Resolving agent names and
 * running the steps happen elsewhere - both still before any subagent is
 * spawned, which is what makes a typo cost nothing.
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Lifetime } from "./agent.ts";
import { asBoolean, asString } from "./markdown.ts";

/** The combinators a pipeline may call, by their exported name. */
export const STEP_KINDS = [
	"chain",
	"fanOut",
	"loop",
	"reduce",
	"route",
	"orchestrate",
	"pair",
	"deliver",
] as const;

/** The name of a combinator, narrowed to the ones a pipeline may name. */
export type StepKind = (typeof STEP_KINDS)[number];

/** One combinator call. `agents` are names; resolution happens later. */
export type PipelineStep = {
	/** Joins the frontmatter entry to its `## <id>` section. Unique. */
	id: string;
	/** The combinator this step calls. Exactly one per step, checked at parse time. */
	kind: StepKind;
	/** The agents carried by the verb itself, in order. */
	agents: string[];
	/** The `## <id>` section, verbatim. Becomes the step's instruction. */
	prompt: string;

	/** `orchestrate` / `deliver`: who may be assigned a subtask. */
	workers?: string[];
	/** `deliver`: the reviewer paired with every worker. */
	reviewer?: string;
	/** `deliver`: reads the finished whole. Optional. */
	auditor?: string;
	/** `route`: the candidate destinations. */
	destinations?: string[];
	/** `route`: used when the router names nobody. Optional. */
	fallback?: string;
	/**
	 * `fanOut`: the branches, spelled out.
	 *
	 * Literal, because a fan-out whose branches come from the previous step is
	 * exactly what `orchestrate` is: a planner decides the split. Keeping tasks
	 * literal here is what removes the need for any templating syntax.
	 */
	tasks?: string[];

	/** Overrides the run's lifetime for this step alone. Defaults to the run's. */
	lifetime?: Lifetime;
	/** Give this step's subagents their own herdr split. Opt-in, like everywhere. */
	openInHerdr?: boolean;
	/** `fanOut` / `orchestrate` / `deliver`: branches in flight at once. */
	concurrency?: number;
	/** `fanOut`: stop at the first failing branch instead of letting the others finish. */
	failFast?: boolean;
	/** `loop`: converged when the output contains this text. */
	until?: string;
	/** `loop`: hard cap on iterations. Defaults to 5 - never reachable by omission. */
	maxIterations?: number;
	/** `pair` / `deliver`: worker-review exchanges per subtask. Defaults to 3. */
	maxRounds?: number;
	/** `orchestrate` / `deliver`: how many subtasks a plan may contain. Defaults to 8. */
	maxTasks?: number;
	/** `deliver`: audit then fix cycles. Defaults to 2. */
	maxAuditRounds?: number;
	/** Deadline **per turn** of this step. No default: see `AskOptions.timeoutMs`. */
	timeoutMs?: number;
};

/** A whole pipeline: its identity, its steps, and the check they must pass. */
export type Pipeline = {
	/** How the pipeline is asked for. Mandatory, like an agent's. */
	name: string;
	/** One line on what it delivers. For a human reading a listing. */
	description?: string;
	/**
	 * The project's own check: a command and its arguments, as a list.
	 *
	 * A list rather than a command line, because splitting `"npm test"` on
	 * whitespace is writing a small shell - and {@link commandVerifier} runs
	 * `execFile` with no shell precisely so that an argument stays an argument.
	 */
	verify?: string[];
	/**
	 * Model pattern for every subagent of this pipeline.
	 *
	 * Top-level only, no per-step knob: agent frontmatter already covers "this
	 * role runs on X", and no shipped pipeline has needed "same agent, another
	 * model at this step". The caller's own `model` beats this one - a file must
	 * not survive a multi-model sweep.
	 */
	model?: string;
	/** Run in order, each one receiving the previous one's output. Never empty. */
	steps: PipelineStep[];
	/** File path, or a free label for a pipeline built in memory. */
	filePath: string;
};

const LIFETIMES: readonly string[] = ["task", "workflow", "session"];

/**
 * Parses a pipeline definition, or throws.
 *
 * Unlike {@link parseAgent}, a malformed file is **not** ignored silently. An
 * agent is discovered; a pipeline is asked for by name, so staying quiet would
 * mean answering "unknown pipeline" to a file that is sitting right there.
 */
export function parsePipeline(content: string, filePath: string): Pipeline {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const where = `${filePath}: `;

	const name = asString(frontmatter.name);
	if (!name) throw new Error(`${where}a pipeline needs a "name".`);

	const rawSteps = frontmatter.steps;
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		throw new Error(`${where}a pipeline needs a non-empty "steps" list.`);
	}

	const sections = parseSections(body);
	const seen = new Set<string>();
	const steps = rawSteps.map((raw, index) => {
		const step = parseStep(raw, index, where);
		if (seen.has(step.id)) throw new Error(`${where}duplicate step id "${step.id}".`);
		seen.add(step.id);

		const prompt = sections.get(step.id);
		// A renamed id on one side only is the mistake this catches, and it is
		// silent otherwise: the step still runs, with no instruction at all.
		if (prompt === undefined) {
			throw new Error(`${where}step "${step.id}" has no "## ${step.id}" section in the body.`);
		}
		return { ...step, prompt };
	});

	for (const id of sections.keys()) {
		if (!seen.has(id)) throw new Error(`${where}section "## ${id}" matches no step.`);
	}

	return {
		name,
		description: asString(frontmatter.description),
		verify: frontmatter.verify === undefined ? undefined : asStrings(frontmatter.verify, `${where}verify`),
		model: asString(frontmatter.model),
		steps,
		filePath,
	};
}

/** Reads the `## <id>` sections. Exactly two hashes: this file is caller-written. */
function parseSections(body: string): Map<string, string> {
	const sections = new Map<string, string>();
	let id: string | undefined;
	let lines: string[] = [];

	const flush = () => {
		if (id !== undefined) sections.set(id, lines.join("\n").trim());
	};

	for (const line of body.split("\n")) {
		const heading = /^##[ \t]+(\S.*)$/.exec(line);
		if (heading) {
			flush();
			id = (heading[1] as string).trim();
			lines = [];
			continue;
		}
		if (id !== undefined) lines.push(line);
	}
	flush();

	return sections;
}

function parseStep(raw: unknown, index: number, where: string): Omit<PipelineStep, "prompt"> {
	if (!isRecord(raw)) throw new Error(`${where}step ${index + 1} is not a mapping.`);

	const id = asString(raw.id);
	if (!id) throw new Error(`${where}step ${index + 1} needs an "id".`);

	const kinds = STEP_KINDS.filter((candidate) => raw[candidate] !== undefined);
	if (kinds.length === 0) {
		throw new Error(`${where}step "${id}" names no combinator. One of: ${STEP_KINDS.join(", ")}.`);
	}
	if (kinds.length > 1) {
		throw new Error(`${where}step "${id}" names several combinators: ${kinds.join(", ")}.`);
	}

	const kind = kinds[0] as StepKind;
	const agents = asNames(raw[kind], `${where}step "${id}": ${kind}`);
	const step: Omit<PipelineStep, "prompt"> = {
		id,
		kind,
		agents,
		workers: raw.workers === undefined ? undefined : asNames(raw.workers, `${where}step "${id}": workers`),
		reviewer: asString(raw.reviewer),
		auditor: asString(raw.auditor),
		destinations:
			raw.destinations === undefined ? undefined : asNames(raw.destinations, `${where}step "${id}": destinations`),
		fallback: asString(raw.fallback),
		tasks: raw.tasks === undefined ? undefined : asStrings(raw.tasks, `${where}step "${id}": tasks`),
		lifetime: asLifetime(raw.lifetime, `${where}step "${id}"`),
		openInHerdr: asBoolean(raw.openInHerdr),
		failFast: asBoolean(raw.failFast),
		until: asString(raw.until),
		concurrency: asCount(raw.concurrency, `${where}step "${id}": concurrency`),
		maxIterations: asCount(raw.maxIterations, `${where}step "${id}": maxIterations`),
		maxRounds: asCount(raw.maxRounds, `${where}step "${id}": maxRounds`),
		maxTasks: asCount(raw.maxTasks, `${where}step "${id}": maxTasks`),
		maxAuditRounds: asCount(raw.maxAuditRounds, `${where}step "${id}": maxAuditRounds`),
		timeoutMs: asCount(raw.timeoutMs, `${where}step "${id}": timeoutMs`),
	};

	checkShape(step, where);
	return step;
}

/**
 * What the combinator's own signature requires, checked here rather than at the
 * call site: a `pair` missing its reviewer must cost nothing, not one session.
 *
 * Only genuine arity is checked. A `loop` over a single agent refining its own
 * output is legitimate, and `maxIterations` already makes it terminate.
 */
function checkShape(step: Omit<PipelineStep, "prompt">, where: string): void {
	const prefix = `${where}step "${step.id}": ${step.kind}`;
	const exactly = (n: number, role: string) => {
		if (step.agents.length !== n) {
			throw new Error(`${prefix} takes exactly ${n} agent${n > 1 ? "s" : ""} (${role}), got ${step.agents.length}.`);
		}
	};

	switch (step.kind) {
		case "pair":
			exactly(2, "worker, reviewer");
			break;
		case "reduce":
			exactly(1, "the agent that synthesises");
			break;
		case "route":
			exactly(1, "the router");
			if (!step.destinations || step.destinations.length < 2) {
				throw new Error(`${prefix} needs at least two "destinations" to choose between.`);
			}
			break;
		case "orchestrate":
			exactly(1, "the planner");
			if (!step.workers || step.workers.length === 0) {
				throw new Error(`${prefix} needs "workers": the planner reads their descriptions to split the brief.`);
			}
			break;
		case "deliver":
			exactly(1, "the planner");
			if (!step.workers || step.workers.length === 0) throw new Error(`${prefix} needs "workers".`);
			if (!step.reviewer) throw new Error(`${prefix} needs a "reviewer".`);
			break;
		case "fanOut":
			if (!step.tasks || step.tasks.length === 0) {
				throw new Error(`${prefix} needs literal "tasks". For a split decided at run time, use orchestrate.`);
			}
			if (step.agents.length !== 1 && step.agents.length !== step.tasks.length) {
				throw new Error(
					`${prefix} takes one agent for every branch, or ${step.tasks.length} (one per task), got ${step.agents.length}.`,
				);
			}
			break;
		case "chain":
		case "loop":
			if (step.agents.length === 0) throw new Error(`${prefix} needs at least one agent.`);
			break;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCount(value: unknown, what: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	const count = typeof value === "string" ? Number(value.trim()) : value;
	if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
		throw new Error(`${what} must be a positive number, got ${JSON.stringify(value)}.`);
	}
	return count;
}

function asLifetime(value: unknown, what: string): Lifetime | undefined {
	const lifetime = asString(value);
	if (lifetime === undefined) return undefined;
	if (!LIFETIMES.includes(lifetime)) {
		throw new Error(`${what}: unknown lifetime "${lifetime}". One of: ${LIFETIMES.join(", ")}.`);
	}
	return lifetime as Lifetime;
}

/** Accepts `a` and `[a, b]` alike: one agent is the common case. */
function asNames(value: unknown, what: string): string[] {
	const names = asStrings(value, what);
	if (names.length === 0) throw new Error(`${what} names no agent.`);
	return names;
}

function asStrings(value: unknown, what: string): string[] {
	const list = Array.isArray(value) ? value : [value];
	return list.map((item) => {
		const text = asString(item);
		if (!text) throw new Error(`${what} must be text, got ${JSON.stringify(item)}.`);
		return text;
	});
}
