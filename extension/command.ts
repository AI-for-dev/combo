/**
 * What every command in this extension stands on.
 *
 * `/build`, `/run`, `/step`, `/swarm` and `/interview` all launch the same
 * shape of work: a roster, a few checks that must pass before anything is
 * spawned, a live view for as long as the work runs, and a `finally` that takes
 * it down and writes what it cost. That shape is written here once. What a
 * command does inside it stays in its own file.
 */

import { commandVerifier, findPipeline, loadAgents, loadPipelines, type Agent, type Pipeline, type PipelineCatalogue, type Verify } from "../src/index.ts";
import type { CommandDeps, Deps } from "./deps.ts";
import type { CommandCtx, RunUi } from "./pi.ts";
import { liveRun, STATUS, type LiveRun, type LiveRunOptions } from "./run-ui.ts";

/**
 * The roster every command runs with.
 *
 * `scope: "both"` because a user typing a command in a repository *is* the
 * explicit request the project-agents rule asks for; `builtin: true` because the
 * agents shipped with this extension are always available, at the lowest
 * priority - one of the user's own, or the repository's, replaces any of them by
 * name. Written once: three call sites drifting on either flag is how `/build`
 * and `/run` end up disagreeing about who exists.
 */
export function loadRoster(ctx: CommandCtx, deps: Pick<Deps, "loadAgents"> = { loadAgents }): Agent[] {
	return deps.loadAgents({ cwd: ctx.cwd, scope: "both", builtin: true });
}

/** The pipelines every command runs with, on the same terms as the roster, for the same reason. */
export function loadCatalogue(ctx: CommandCtx, deps: Pick<Deps, "loadPipelines"> = { loadPipelines }): PipelineCatalogue {
	return deps.loadPipelines({ cwd: ctx.cwd, scope: "both", builtin: true });
}

/** Notifies and returns `undefined` - the shape every refusal in these commands has. */
export function refuse(ctx: CommandCtx, message: string, level: "info" | "warning" | "error"): undefined {
	ctx.ui.notify(message, level);
	return undefined;
}

/**
 * The checks that must pass before anything is spawned.
 *
 * A typo costs a second here rather than a step of real work. Whatever `check`
 * throws is an explanation meant for the user: it is shown, and `undefined`
 * comes back - the same shape as every other refusal.
 */
export async function checked<T>(ctx: CommandCtx, check: () => T | Promise<T>): Promise<T | undefined> {
	try {
		return await check();
	} catch (cause) {
		return refuse(ctx, cause instanceof Error ? cause.message : String(cause), "error");
	}
}

/** What is watched while it works, and where the trace of it lands. */
export type Watched<T> = {
	/** The footer while the work runs: `building…`, `running explore…`. Absent leaves the footer alone. */
	status?: string;
	/** Where `usage.json` is written when it is over. Absent writes none. */
	dir: string | undefined;
	/**
	 * What this caller varies about the view: the tool streams a progress line
	 * and knows the parent session, a test injects a spawn and a reporter.
	 */
	live?: Pick<LiveRunOptions, "reporter" | "herdrAll" | "onChange" | "mainSessionFile" | "spawn">;
	/** The work, handed the live run: its `signal`, its `spawn`, its `onEvent`. */
	work: (live: LiveRun) => Promise<T>;
};

/** Who stands on the floor: a command with pi's context, or the tool with what pi handed it. */
export type Watcher = { ui?: RunUi; signal?: AbortSignal };

/**
 * Runs the work under the dots, and takes them down whatever happens.
 *
 * One painter, one `finally`, one clock: the live view goes up, the footer says
 * what is running, and on the way out - thrown or not - the widget and the
 * footer are cleared and the run's `usage.json` written with the time the view
 * measured. A thrown `work` still throws, after the clean-up.
 */
export async function watched<T>(ctx: Watcher, deps: Pick<CommandDeps, "tickMs">, at: Watched<T>): Promise<T> {
	const live = liveRun(ctx.ui, { ...at.live, dir: at.dir, tickMs: deps.tickMs, signal: ctx.signal });
	if (at.status) ctx.ui?.setStatus?.(STATUS, at.status);
	try {
		return await at.work(live);
	} finally {
		live.stop();
	}
}

/**
 * The pipeline a command runs, or a thrown explanation.
 *
 * With no name, it is the one called `build`: the package ships one, and a
 * `build.md` of your own replaces it by having the same name. There is
 * therefore exactly **one** default, and it is a file you can read and copy -
 * a second one written in TypeScript would differ from it within two changes.
 * A broken file is refused rather than silently replaced, by the lookup itself.
 */
export function choosePipeline(wanted: string | undefined, ctx: CommandCtx, deps: Pick<Deps, "loadPipelines">): Pipeline {
	return findPipeline(loadCatalogue(ctx, deps), wanted ?? "build");
}

/** The first `n` lines, for a dialog that must stay readable. */
export function firstLines(text: string, n: number): string {
	const lines = text.trim().split("\n");
	return lines.length <= n ? lines.join("\n") : `${lines.slice(0, n).join("\n")}\n…`;
}

/**
 * The check a pipeline names, as a port. Absent means the pipeline names none.
 *
 * A pipeline *names* a command; running one is a decision that belongs to
 * whoever owns the working tree, which is why this lives beside the commands and
 * not inside the runner.
 */
export function pipelineVerifier(pipeline: Pipeline, cwd: string): Verify | undefined {
	const parts = pipeline.verify;
	if (!parts || parts.length === 0) return undefined;
	return commandVerifier({ cwd, command: parts[0] as string, args: parts.slice(1) });
}
