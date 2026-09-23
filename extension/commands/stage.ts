/**
 * One stage of a hand-walked chain: what a name points at, and how it runs.
 *
 * A stage is deliberately either a flow or a lone agent - `explore` is a
 * fan-out and a synthesis, `planner` is one turn, and both are perfectly good
 * things to put between two others. They answer in different shapes, and this
 * is where that stops mattering: a `FlowResult` and a `Result` both come out
 * of here as the same fields.
 *
 * It lives apart from the commands for the usual reason: resolution has to
 * happen **before** anything is spawned, so that a typo costs a second rather
 * than a step of real work, and a function that only resolves can be asserted
 * on without running anything. A flow is held to this terminal there too, so
 * a flow that cannot run here is refused before its first turn.
 */

import { findAgent, readJournal, type Agent, type CheckedRun, type Usage } from "../../src/index.ts";
import { loadFlows, watched } from "../command.ts";
import type { Deps } from "../deps.ts";
import type { CommandCtx } from "../pi.ts";
import { asText, failure, resumeHint, shown } from "./answer.ts";
import { launch, launchable, notLaunched } from "./launch.ts";

/** What a step turned out to name, checked to run here. Resolved before anything is spawned. */
export type Target = { kind: "flow"; run: CheckedRun } | { kind: "agent"; agent: Agent };

/** What a stage produced. A failure is `failed` here, never a throw. */
export type Done = {
	/** The material the next step may carry. */
	output: string;
	/** What it cost, whether it worked or not. */
	usage: Usage;
	/** Set if and only if the stage failed: what went wrong, and what can be done with what ran. */
	failed?: { why: string; next: string };
};

/** What running a stage needs from the command that asked for it. */
export type Stage = {
	ctx: CommandCtx;
	deps: Deps;
	/** Where this stage's transcripts and `usage.json` land, and a flow's run directory. */
	dir: string;
	/** Beats the flow file's model, and the agent's frontmatter. */
	model?: string;
	/** The footer while it runs. */
	status: string;
};

/**
 * The flow or agent a name points at, flows first.
 *
 * Flows first because a flow is *asked for* by name and an agent is
 * discovered, and `--agent` is there so that a name held by both is not a dead
 * end. A name held by neither says so in one message rather than sending
 * whoever typed it round two listings.
 */
export async function resolveTarget(name: string, forceAgent: boolean, ctx: CommandCtx, deps: Deps, agents: Agent[]): Promise<Target> {
	if (forceAgent) return { kind: "agent", agent: findAgent(agents, name) };

	const catalogue = loadFlows(ctx, deps);
	const agent = agents.find((one) => one.name === name);
	// A broken file of that name is refused below, and never fallen past to an
	// agent that happens to share the name.
	if (!catalogue.flows.some((one) => one.name === name)) {
		if (agent) return { kind: "agent", agent };
		throw new Error(`step: \`${name}\` is neither a flow nor an agent. /flows and /agents list them, and from where`);
	}
	const flow = await launchable(name, catalogue, ctx);
	if (!flow.ok) throw new Error(notLaunched("step", name, flow, ctx.cwd));
	if (agent) ctx.ui.notify(`step: \`${name}\` is both a flow and an agent - running the flow, --agent runs the other`, "info");
	return { kind: "flow", run: flow.run };
}

/**
 * Runs the stage under the live view, and flattens the two shapes into one.
 *
 * The caller has no business knowing which of the two ran: what a step keeps is
 * the output, the usage and whether it worked, and that is the same either way.
 * A flow runs in `dir` as its run directory, so `/run resume` can carry on
 * one that stopped.
 */
export async function runStage(target: Target, input: string, stage: Stage): Promise<Done> {
	const { ctx, deps, dir, model, status } = stage;

	if (target.kind === "flow") {
		const result = await launch(ctx, deps, target.run, input, { runDir: dir, model, status, mainSession: ctx.sessionManager });
		if (result.ok) return { output: asText(result.output), usage: result.usage };
		return { output: "", usage: result.usage, failed: { why: failure(result), next: resumeHint(ctx, target.run.flow, readJournal(dir), dir) } };
	}

	const result = await watched(ctx, deps, {
		status,
		dir,
		work: (live) => deps.run(target.agent, input, { cwd: ctx.cwd, exportDir: dir, model, signal: live.signal, spawn: live.spawn, onEvent: live.onEvent }),
	});
	if (result.ok) return { output: result.output, usage: result.usage };
	return { output: result.output, usage: result.usage, failed: { why: `failed: ${result.error ?? "unknown error"}`, next: `what ran is in ${shown(ctx, dir)}` } };
}
