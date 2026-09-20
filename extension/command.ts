/**
 * What every command in this extension stands on.
 *
 * `/build`, `/run`, `/step`, `/swarm` and `/interview` all launch the same
 * shape of work: a roster, a few checks that must pass before anything is
 * spawned, a live view for as long as the work runs, and a `finally` that takes
 * it down and writes what it cost. That shape is written here once. What a
 * command does inside it stays in its own file.
 */

import { commandVerifier, loadAgents, findPipeline, type Agent, type Pipeline, type Verify } from "../src/index.ts";
import type { AskUi } from "./ask-ui.ts";
import type { CommandDeps, Deps } from "./deps.ts";
import { liveRun, STATUS, type LiveRun } from "./run-ui.ts";

/** What these commands need from pi. Narrow on purpose: a test can stand in for it. */
export type CommandCtx = {
	cwd: string;
	hasUI?: boolean;
	signal?: AbortSignal;
	ui: AskUi & {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		editor(title: string, prefill?: string): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		setEditorText(text: string): void;
		setWidget?(key: string, lines: string[] | undefined): void;
	};
};

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

/** What a command watches while it works, and where the trace of it lands. */
export type Watched<T> = {
	/** The footer while the work runs: `building…`, `running explore…`. */
	status: string;
	/** Where `usage.json` is written when it is over. Absent writes none. */
	dir: string | undefined;
	/** The work, handed the live run: its `signal`, its `spawn`, its `onEvent`. */
	work: (live: LiveRun) => Promise<T>;
};

/**
 * Runs the work under the dots, and takes them down whatever happens.
 *
 * One painter, one `finally`, one clock: the live view goes up, the footer says
 * what is running, and on the way out - thrown or not - the widget and the
 * footer are cleared and the run's `usage.json` written with the time this
 * command measured. A thrown `work` still throws, after the clean-up.
 */
export async function watched<T>(ctx: CommandCtx, deps: Pick<CommandDeps, "tickMs">, at: Watched<T>): Promise<T> {
	const live = liveRun(ctx.ui, { tickMs: deps.tickMs, signal: ctx.signal });
	ctx.ui.setStatus(STATUS, at.status);
	const startedAt = performance.now();
	try {
		return await at.work(live);
	} finally {
		live.stop(at.dir, performance.now() - startedAt);
	}
}

/**
 * The pipeline this build runs, or a thrown explanation.
 *
 * With no `--pipeline`, it is the one named `build`: the package ships one, and
 * a `build.md` of your own replaces it by having the same name. There is
 * therefore exactly **one** default, and it is a file you can read and copy -
 * a second one written in TypeScript would differ from it within two changes.
 *
 * A **broken** file is refused rather than silently replaced: a `build.md`
 * sitting there and quietly not being used is exactly the failure
 * `findPipeline` exists to make loud. `command` only names the caller in that
 * message - `/run` refuses a broken file for the same reason `/build` does.
 */
export function choosePipeline(wanted: string | undefined, ctx: CommandCtx, deps: Pick<Deps, "loadPipelines">, command = "build"): Pipeline {
	const catalogue = deps.loadPipelines({ cwd: ctx.cwd, scope: "both", builtin: true });
	const name = wanted ?? "build";

	const broken = catalogue.broken.find((one) => one.name === name);
	if (broken) throw new Error(`${command}: ${broken.filePath} does not parse: ${broken.error}`);

	return findPipeline(catalogue, name);
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
