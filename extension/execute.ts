/**
 * The body of the `subagent` tool: argument → combinator → result.
 *
 * It lives apart from `index.ts` for one reason: **everything it touches is
 * injectable**. Loading the agents, spawning, the herdr reporter and the widget
 * surface all arrive as parameters, so the path that wires the reporters and
 * calls the combinators can be tested offline - like the combinators
 * themselves. The three bugs that reached the user through this path (an
 * `undefined` model API, a herdr reporter nobody subscribed, an `openInHerdr`
 * silently dropped) were all invisible to a green suite because this code had
 * no seam.
 *
 * `index.ts` keeps what genuinely needs a terminal: the renderers.
 */

import {
	chain,
	createRunDir,
	fanOut,
	findAgent,
	loadAgents as loadAgentsFromDisk,
	loop,
	orchestrate,
	reduce,
	route,
	progressLine,
	type Agent,
	type AgentScope,
	type EventListener,
	type Lifetime,
	type Result,
	type SpawnFn,
	type SubagentSnapshot,
} from "../src/index.ts";
import { liveRun, type RunUi } from "./run-ui.ts";

/** The arguments the model sends. Every field optional: the mode is inferred. */
export type Params = {
	mode?: string;
	agent?: string;
	task?: string;
	tasks?: string[];
	steps?: string[];
	lifetime?: string;
	/** Model pattern for every subagent of this call. Beats agent frontmatter. */
	model?: string;
	concurrency?: number;
	until?: string;
	maxIterations?: number;
	maxTasks?: number;
	timeoutMs?: number;
	openInHerdr?: boolean;
	/** Give **every** subagent of this call a split, not only the ones that asked. */
	herdrAll?: boolean;
	scope?: string;
	export?: boolean;
	reduceWith?: string;
	candidates?: string[];
};

/** What `renderResult` needs, and nothing the LLM has to read. */
export type Details = {
	mode: string;
	subagents: SubagentSnapshot[];
	wallMs: number;
	converged?: boolean;
	iterations?: number;
	/** For route and orchestrate: what the deciding agent chose. */
	decision?: string;
	/** Where the run was exported, when one was asked for. */
	exportDir?: string;
};

/** A streamed update: text for the model, no details until the run is over. */
export type ToolUpdate = { content: { type: "text"; text: string }[]; details: undefined };

/** The tool's final answer: what the model reads, plus what the renderers draw. */
export type ToolOutput = {
	content: { type: "text"; text: string }[];
	details: Details;
};

/** Everything the tool body reaches for. Defaults are the real thing. */
export type ExecuteDeps = {
	cwd?: string;
	signal?: AbortSignal;
	onUpdate?: (update: ToolUpdate) => void;
	ui?: RunUi;
	/** Defaults to reading the agent directories from disk. */
	loadAgents?: (options: { cwd?: string; scope?: AgentScope; builtin?: boolean }) => Agent[];
	/** Defaults to the real `spawn`, through the combinators. */
	spawn?: SpawnFn;
	/**
	 * A second observer beside the TUI collector. Defaults to the herdr
	 * reporter, which is `undefined` unless pi itself runs inside herdr.
	 */
	reporter?: EventListener;
	/** Widget repaint period. `0` disables the timer - tests want that. */
	tickMs?: number;
	/** Where an export lands. Defaults to a fresh `runs/<timestamp>/`. */
	runDir?: () => string;
	/**
	 * The parent session's JSONL, from `ctx.sessionManager.getSessionFile()`.
	 *
	 * An orchestration export that lost the parent session would be half a
	 * story - and the extension is the only place that knows this path.
	 */
	mainSessionFile?: string;
};

/**
 * Runs one `subagent` tool call.
 *
 * Never throws for a workflow failure: a failed subagent comes back as a
 * `Result` with `ok: false`. It does throw for a caller error - an unknown
 * agent, a missing `steps` - because that is a programming mistake, not a
 * result.
 */
export async function executeSubagent(params: Params, deps: ExecuteDeps = {}): Promise<ToolOutput> {
	// `builtin: true`: the agents shipped with this extension are always in the
	// roster, at the lowest priority - one of the user's own, or the
	// repository's, replaces any of them by name.
	const agents = (deps.loadAgents ?? loadAgentsFromDisk)({ cwd: deps.cwd, scope: asScope(params.scope), builtin: true });
	const mode = inferMode(params);

	// The same dots, timer and report `/build` and `/run` get. Streaming the
	// progress line is the one thing only the tool does: the row redraws as the
	// subagents work, rather than sitting on an opaque spinner until the end.
	const live = liveRun(deps.ui, {
		tickMs: deps.tickMs,
		reporter: deps.reporter,
		herdrAll: params.herdrAll,
		mainSessionFile: deps.mainSessionFile,
		onChange: (snapshot) =>
			deps.onUpdate?.({ content: [{ type: "text", text: progressLine(snapshot) }], details: undefined }),
	});
	const collector = live.collector;

	// The directory is created up front: subagents export themselves as they
	// close, so it has to exist before the first one finishes.
	const exportDir = params.export ? (deps.runDir ?? createRunDir)() : undefined;

	const shared = {
		lifetime: asLifetime(params.lifetime),
		exportDir,
		signal: deps.signal,
		timeoutMs: params.timeoutMs,
		openInHerdr: params.openInHerdr,
		model: params.model,
		cwd: deps.cwd,
		spawn: deps.spawn,
		onEvent: live.onEvent,
	};

	const startedAt = performance.now();
	let results: Result[] = [];
	let converged: boolean | undefined;
	let iterations: number | undefined;
	let decision: string | undefined;

	// The widget must go even when the workflow throws - an unknown agent name,
	// for one - or a dead row of dots sits above the prompt forever.
	try {
		switch (mode) {
			case "parallel": {
				const tasks = params.tasks ?? [];
				const outcome = await fanOut({ ...shared, agent: pick(agents, params.agent), tasks, concurrency: params.concurrency });
				results = outcome.results;
				break;
			}
			case "chain": {
				const outcome = await chain({ ...shared, steps: stepsOf(agents, params.steps), input: params.task ?? "" });
				results = outcome.steps;
				break;
			}
			case "loop": {
				const needle = params.until;
				const outcome = await loop({
					...shared,
					steps: stepsOf(agents, params.steps),
					input: params.task ?? "",
					until: needle ? (step) => step.output.includes(needle) : undefined,
					maxIterations: params.maxIterations,
				});
				results = outcome.steps;
				converged = outcome.converged;
				iterations = outcome.iterations;
				break;
			}
			case "route": {
				const outcome = await route({
					...shared,
					router: pick(agents, params.agent),
					destinations: stepsOf(agents, params.candidates, "candidates"),
					input: params.task ?? "",
				});
				results = [outcome];
				decision = outcome.destination?.name;
				break;
			}
			case "orchestrate": {
				const outcome = await orchestrate({
					...shared,
					planner: pick(agents, params.agent),
					workers: stepsOf(agents, params.candidates, "candidates"),
					input: params.task ?? "",
					concurrency: params.concurrency,
					maxTasks: params.maxTasks,
					reduceWith: params.reduceWith ? pick(agents, params.reduceWith, "reduceWith") : undefined,
				});
				// The plan is what a reader wants to see: who was asked what.
				decision = outcome.plan.map((step) => `${step.agent.name}: ${step.task}`).join("; ");
				results = outcome.answer ? [outcome.answer] : outcome.results;
				if (!outcome.ok && results.length === 0) results = [outcome.planning];
				break;
			}
			case "reduce": {
				const branches = await fanOut({
					...shared,
					agent: pick(agents, params.agent),
					tasks: params.tasks ?? [],
					concurrency: params.concurrency,
				});
				const answer = await reduce({
					...shared,
					agent: pick(agents, params.reduceWith, "reduceWith"),
					results: branches.results,
					input: params.task ?? "Synthesise these results into a single answer.",
				});
				// Only the synthesis goes to the model: handing it the branches as
				// well would undo the very context saving the reduction is for.
				results = [answer];
				break;
			}
			default: {
				const outcome = await fanOut({ ...shared, agent: pick(agents, params.agent), tasks: [params.task ?? ""] });
				results = outcome.results;
				break;
			}
		}
	} finally {
		// In the `finally` on purpose: a run that was cancelled, or that died on
		// an unknown agent, still has work worth keeping. The subagents' own
		// transcripts landed as they closed; `stop` adds what only we produce.
		live.stop(exportDir, performance.now() - startedAt);
	}

	const wallMs = performance.now() - startedAt;
	const snapshot = collector.snapshot();

	return {
		// What the model reads: the outputs, not the chrome.
		content: [{ type: "text", text: textForModel(results, converged, iterations) }],
		details: { mode, subagents: snapshot.subagents, wallMs, converged, iterations, decision, exportDir },
	};
}

/** What the model gets back: the outputs, plainly labelled. */
export function textForModel(results: Result[], converged?: boolean, iterations?: number): string {
	if (results.length === 0) return "(no subagent ran)";

	const parts = results.map((result) =>
		result.ok ? `## ${result.agent}\n${result.output}` : `## ${result.agent} (failed)\n${result.error ?? "unknown error"}`,
	);
	if (converged !== undefined) {
		parts.push(converged ? `\n(converged after ${iterations} iteration(s))` : `\n(did NOT converge after ${iterations} iteration(s))`);
	}
	return parts.join("\n\n");
}

/** Infers the mode from what was actually provided. */
export function inferMode(params: Params): string {
	if (params.mode) return params.mode;
	if (params.candidates) return "route";
	if (params.reduceWith) return "reduce";
	if (params.until || params.maxIterations) return "loop";
	if (params.steps?.length) return "chain";
	if (params.tasks?.length) return "parallel";
	return "single";
}

/** `field` names the argument that was missing: an error is read by a model too. */
function pick(agents: Agent[], name: string | undefined, field = "agent"): Agent {
	if (!name) throw new Error(`subagent: \`${field}\` is required for this mode`);
	return findAgent(agents, name);
}

function stepsOf(agents: Agent[], names: string[] | undefined, field = "steps"): Agent[] {
	if (!names?.length) throw new Error(`subagent: \`${field}\` is required for this mode`);
	return names.map((name) => findAgent(agents, name));
}

function asLifetime(value: string | undefined): Lifetime | undefined {
	return value === "task" || value === "workflow" || value === "session" ? value : undefined;
}

function asScope(value: string | undefined): AgentScope | undefined {
	return value === "user" || value === "project" || value === "both" ? value : undefined;
}
