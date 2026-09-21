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
	declaresDelegate,
	delegateTool,
	fanOut,
	findAgent,
	joinOutputs,
	loadAgents as loadAgentsFromDisk,
	loop,
	orchestrate,
	plural,
	reduce,
	route,
	progressLine,
	saysWord,
	type Agent,
	type AgentScope,
	type EventListener,
	type Result,
	type SpawnFn,
	type SubagentSnapshot,
	type WorkflowOptions,
} from "../src/index.ts";
import { watched } from "./command.ts";
import { inferMode, type Mode, type Params } from "./params.ts";
import type { ToolDeps } from "./pi.ts";

/** What `renderResult` needs, and nothing the LLM has to read. */
export type Details = {
	mode: Mode;
	subagents: SubagentSnapshot[];
	wallMs: number;
	converged?: boolean;
	iterations?: number;
	/** For route and orchestrate: what the deciding agent chose. */
	decision?: string;
	/** Where the run was exported, when one was asked for. */
	exportDir?: string;
};

/** The tool's final answer: what the model reads, plus what the renderers draw. */
export type ToolOutput = {
	content: { type: "text"; text: string }[];
	details: Details;
};

/** Everything the tool body reaches for: what pi handed it, and what a test may replace. Defaults are the real thing. */
export type ExecuteDeps = Partial<ToolDeps> & {
	/** Defaults to reading the agent directories from disk. */
	loadAgents?: (options: { cwd?: string; scope?: AgentScope; builtin?: boolean }) => Agent[];
	/** Defaults to the real `spawn`, through the combinators. */
	spawn?: SpawnFn;
	/**
	 * A second observer beside the TUI picture. Defaults to the herdr
	 * reporter, which is `undefined` unless pi itself runs inside herdr.
	 */
	reporter?: EventListener;
	/** Widget repaint period. `0` disables the timer - tests want that. */
	tickMs?: number;
	/** Where an export lands. Defaults to a fresh `runs/<timestamp>/`. */
	runDir?: () => string;
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
	const agents = (deps.loadAgents ?? loadAgentsFromDisk)({ cwd: deps.cwd, scope: params.scope, builtin: true });
	const mode = inferMode(params);

	// The directory is created up front: subagents export themselves as they
	// close, so it has to exist before the first one finishes.
	const exportDir = params.export ? (deps.runDir ?? createRunDir)() : undefined;

	// The same floor `/build` and `/run` stand on: the dots, the timer, the
	// `finally` and `usage.json`. Streaming the progress line is the one thing
	// only the tool does: the row redraws as the subagents work, rather than
	// sitting on an opaque spinner until the end.
	const ran = await watched(deps, { tickMs: deps.tickMs }, {
		dir: exportDir,
		live: {
			reporter: deps.reporter,
			herdrAll: params.herdrAll,
			mainSessionFile: deps.mainSessionFile,
			spawn: deps.spawn,
			onChange: (snapshot) => deps.onUpdate?.({ content: [{ type: "text", text: progressLine(snapshot) }], details: undefined }),
		},
		work: async (live) => {
			// What every subagent of this call runs on. The children of a
			// delegating one get the same, minus the lifetime: a delegated child
			// is disposable.
			//
			// The signal and the spawn are the run's, not the caller's: that is
			// what puts every subagent of this call - delegated children included
			// - within reach of Escape and of `/stop`.
			const inherited = {
				exportDir,
				signal: live.signal,
				timeoutMs: params.timeoutMs,
				openInHerdr: params.openInHerdr,
				model: params.model,
				cwd: deps.cwd,
				spawn: live.spawn,
				onEvent: live.onEvent,
			};
			const shared: WorkflowOptions = {
				...inherited,
				lifetime: params.lifetime,
				// Delegation is enabled by the definition, never by this call: an
				// agent whose `tools:` names `subagent` is handed one, anybody else
				// is offered nothing. The roster it may reach is this call's, and
				// the bound is `maxDepth`.
				customTools: (agent: Agent) =>
					declaresDelegate(agent.tools)
						? (id: string) => [delegateTool({ ...inherited, agents, holder: agent, parentId: id, maxDepth: params.maxDepth })]
						: undefined,
			};
			const outcome = await perform(mode, params, agents, shared);
			return { ...outcome, snapshot: live.picture.snapshot(), wallMs: live.elapsedMs() };
		},
	});

	return {
		// What the model reads: the outputs, not the chrome.
		content: [{ type: "text", text: textForModel(ran.results, ran.converged, ran.iterations) }],
		details: { mode, subagents: ran.snapshot.subagents, wallMs: ran.wallMs, converged: ran.converged, iterations: ran.iterations, decision: ran.decision, exportDir },
	};
}

/** What one mode produced: the results the model reads, and what the row says about how it went. */
type Performed = Pick<Details, "converged" | "iterations" | "decision"> & { results: Result[] };

/** Runs the combinator a mode names, with the arguments the model gave it. */
async function perform(mode: Mode, params: Params, agents: Agent[], shared: WorkflowOptions): Promise<Performed> {
	switch (mode) {
		case "parallel": {
			const outcome = await fanOut({ ...shared, agent: pick(agents, params.agent), tasks: params.tasks ?? [], concurrency: params.concurrency });
			return { results: outcome.results };
		}
		case "chain": {
			const outcome = await chain({ ...shared, steps: stepsOf(agents, params.steps), input: params.task ?? "" });
			return { results: outcome.steps };
		}
		case "loop": {
			const needle = params.until;
			const outcome = await loop({
				...shared,
				steps: stepsOf(agents, params.steps),
				input: params.task ?? "",
				until: needle ? (step) => saysWord(step.output, needle) : undefined,
				maxIterations: params.maxIterations,
			});
			return { results: outcome.steps, converged: outcome.converged, iterations: outcome.iterations };
		}
		case "route": {
			const outcome = await route({
				...shared,
				router: pick(agents, params.agent),
				destinations: stepsOf(agents, params.candidates, "candidates"),
				input: params.task ?? "",
			});
			return { results: [outcome], decision: outcome.destination?.name };
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
			const decision = outcome.plan.map((step) => `${step.agent.name}: ${step.task}`).join("; ");
			// The synthesis alone when there is one, every subtask otherwise,
			// and the orchestration's own word when nothing ran.
			const results = outcome.answer ? [outcome.answer] : outcome.results.length > 0 ? outcome.results : [outcome];
			return { results, decision };
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
			return { results: [answer] };
		}
		case "single": {
			const outcome = await fanOut({ ...shared, agent: pick(agents, params.agent), tasks: [params.task ?? ""] });
			return { results: outcome.results };
		}
	}
}

/** What the model gets back: the outputs, plainly labelled. */
export function textForModel(results: Result[], converged?: boolean, iterations?: number): string {
	if (results.length === 0) return "(no subagent ran)";

	const parts = [joinOutputs(results)];
	if (converged !== undefined) {
		parts.push(`\n(${converged ? "converged" : "did NOT converge"} after ${plural(iterations ?? 0, "iteration")})`);
	}
	return parts.join("\n\n");
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

