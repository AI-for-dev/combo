/**
 * One stage of a hand-walked chain: what a name points at, and how it runs.
 *
 * A stage is deliberately either a pipeline or a lone agent - `explore` is a
 * fan-out and a synthesis, `planner` is one turn, and both are perfectly good
 * things to put between two others. They answer in different shapes, and this
 * is where that stops mattering: a `PipelineRunResult` and a `Result` both come
 * out of here as the same three fields.
 *
 * It lives apart from the commands for the usual reason: resolution has to
 * happen **before** anything is spawned, so that a typo costs a second rather
 * than a step of real work, and a function that only resolves can be asserted
 * on without running anything.
 */

import { findAgent, type Agent, type EventListener, type Pipeline, type SpawnFn, type Usage } from "../src/index.ts";
import { pipelineVerifier } from "./command.ts";
import type { Deps } from "./deps.ts";
import type { CommandCtx } from "./pi.ts";

/** What a step turned out to name. Resolved before anything is spawned. */
export type Target = { kind: "pipeline"; pipeline: Pipeline } | { kind: "agent"; agent: Agent };

/** What a stage produced. A failure is an `error` here, never a throw. */
export type Done = {
	/** The material the next step may carry. */
	output: string;
	/** What it cost, whether it worked or not. */
	usage: Usage;
	/** Set if and only if the stage failed. */
	error?: string;
};

/** What running a stage needs from the command that asked for it. */
export type Stage = {
	/** The roster the pipeline's step names were resolved against. */
	agents: Agent[];
	ctx: CommandCtx;
	deps: Deps;
	/** Where this stage's transcripts and `usage.json` land. */
	dir: string;
	/** Beats the pipeline file's model, and the agent's frontmatter. */
	model?: string;
	/**
	 * A copy of the repository per worker, for a pipeline step that delivers.
	 *
	 * Absent means nobody said: the delivery then decides from the size of its
	 * own plan. Passing `false` for an unsaid flag is how that decision was lost.
	 */
	worktree?: boolean;
	onEvent: EventListener;
	/** The run's signal, not the command's: Escape and `/stop all` fire it. */
	signal?: AbortSignal;
	/** The run's `spawn`, which is what puts its subagents within reach of `/stop`. */
	spawn?: SpawnFn;
};

/**
 * The agent or pipeline a name points at, pipelines first.
 *
 * Pipelines first because a pipeline is *asked for* by name and an agent is
 * discovered, and `--agent` is there so that a name held by both is not a dead
 * end. A name held by neither says so in one message rather than sending
 * whoever typed it round two listings.
 */
export function resolveTarget(name: string, forceAgent: boolean, ctx: CommandCtx, deps: Deps, agents: Agent[]): Target {
	if (forceAgent) return { kind: "agent", agent: findAgent(agents, name) };

	const catalogue = deps.loadPipelines({ cwd: ctx.cwd, scope: "both", builtin: true });
	const broken = catalogue.broken.find((one) => one.name === name);
	if (broken) throw new Error(`step: ${broken.filePath} does not parse: ${broken.error}`);

	const pipeline = catalogue.pipelines.find((one) => one.name === name);
	const agent = agents.find((one) => one.name === name);
	if (!pipeline && !agent) {
		throw new Error(
			`step: \`${name}\` is neither a pipeline nor an agent. /pipelines and /agents list what is loaded, and from where`,
		);
	}
	if (!pipeline) return { kind: "agent", agent: agent as Agent };

	if (agent) ctx.ui.notify(`step: \`${name}\` is both a pipeline and an agent - running the pipeline, --agent runs the other`, "info");
	return { kind: "pipeline", pipeline };
}

/**
 * Runs the stage, and flattens the two shapes into one.
 *
 * The caller has no business knowing which of the two ran: what a step keeps is
 * the output, the usage and whether it worked, and that is the same either way.
 */
export async function runStage(target: Target, input: string, stage: Stage): Promise<Done> {
	const { agents, ctx, deps, dir, model, onEvent, signal, spawn } = stage;

	if (target.kind === "pipeline") {
		const done = await deps.runPipeline({
			pipeline: target.pipeline,
			agents,
			input,
			cwd: ctx.cwd,
			exportDir: dir,
			verify: deps.verify ?? pipelineVerifier(target.pipeline, ctx.cwd),
			model,
			worktree: stage.worktree,
			signal,
			spawn,
			onEvent,
		});
		return { output: done.output, usage: done.usage, error: done.ok ? undefined : (done.error ?? "unknown error") };
	}

	const result = await deps.run(target.agent, input, {
		cwd: ctx.cwd,
		exportDir: dir,
		model,
		signal,
		spawn,
		onEvent,
	});
	return { output: result.output, usage: result.usage, error: result.ok ? undefined : (result.error ?? "unknown error") };
}
