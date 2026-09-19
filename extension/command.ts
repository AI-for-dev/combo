/**
 * What every command in this extension stands on.
 *
 * `/build`, `/run`, `/step` and `/agents` all need the same four things: the
 * slice of pi they are handed, the doubles a test puts in its place, the roster
 * they run with, and one way of saying no. They used to reach into `build.ts`
 * for them, which made `/agents` depend on the build state machine to know what
 * a command context is.
 *
 * Nothing here knows about any one command. What a command does stays in its
 * own file.
 */

import {
	checkModel,
	commitAll,
	createBranch,
	diff,
	diffStat,
	findPipeline,
	interview,
	isRepository,
	loadAgents,
	loadPipelines,
	findResumableBuild,
	run,
	runPipeline,
	saveBuildState,
	status,
	swarm,
	untracked,
	type Agent,
	type Pipeline,
	type Verify,
} from "../src/index.ts";
import type { AskUi } from "./ask-ui.ts";

/**
 * Everything a command reaches for, injectable.
 *
 * The same seam as the tool body, for the same reason: the only bugs that ever
 * reached a user through this extension were in the wiring, and wiring is only
 * testable when it can be handed doubles. Defaults are the real thing.
 */
export type BuildDeps = {
	loadAgents?: typeof loadAgents;
	/** Where the pipelines come from. Defaults to `~/.pi/agent/pipelines` and `.pi/pipelines`. */
	loadPipelines?: typeof loadPipelines;
	interview?: typeof interview;
	/** Runs the pipeline. The command's one seam onto the whole of the work. */
	runPipeline?: typeof runPipeline;
	/** Runs one throwaway agent: `/build` uses it for the commit message. */
	run?: typeof run;
	/** Puts several copies of one agent on one job: `/swarm`'s whole of the work. */
	swarm?: typeof swarm;
	/** Every git call, so a test never touches a repository it did not make. */
	git?: {
		isRepository: typeof isRepository;
		status: typeof status;
		diff: typeof diff;
		diffStat: typeof diffStat;
		untracked: typeof untracked;
		createBranch: typeof createBranch;
		commitAll: typeof commitAll;
	};
	/** Where transcripts land. Defaults to a fresh `runs/<timestamp>/`. */
	runDir?: () => string;
	/** The project's own check. Defaults to asking the user for a command. */
	verify?: Verify;
	/** Where an interrupted build is looked for. Defaults to `runs/`. */
	findResumable?: typeof findResumableBuild;
	/** Persists progress. Defaults to writing `build.json` into the run directory. */
	saveState?: typeof saveBuildState;
	/** Validates a `--model` pattern before anything runs. Touches the real pi. */
	checkModel?: typeof checkModel;
	/** Widget repaint period. `0` disables the timer - tests want that. */
	tickMs?: number;
};

/** The real git, and the default of every `deps.git`. */
export const REAL_GIT = { isRepository, status, diff, diffStat, untracked, createBranch, commitAll };

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
export function loadRoster(ctx: CommandCtx, deps: BuildDeps = {}): Agent[] {
	return (deps.loadAgents ?? loadAgents)({ cwd: ctx.cwd, scope: "both", builtin: true });
}

/**
 * `/build [--pipeline <name>] [--model <pattern>] <request>`.
 *
 * Flags rather than positional words, because a request is free text: any
 * convention that reads the first word as a pipeline name eventually swallows
 * someone's "build fix the parser". Both flags, in either order.
 */
export function parseBuildArgs(args: string): {
	pipeline?: string;
	model?: string;
	worktree?: boolean;
	questions?: number;
	request: string;
} {
	const { flags, rest } = parseLeadingFlags(args, ["pipeline", "model", "questions"], ["worktree"]);
	const parsed: ReturnType<typeof parseBuildArgs> = { request: rest };
	if (flags.pipeline) parsed.pipeline = flags.pipeline;
	if (flags.model) parsed.model = flags.model;
	// Set only when it was written: an explicit `undefined` spread over a default
	// silently wins, and the default is the whole point of leaving it unsaid.
	const worktree = switchValue(flags, "worktree");
	if (worktree !== undefined) parsed.worktree = worktree;

	// A count that is not one is dropped rather than guessed at: `--questions x`
	// is a typo, and turning it into 0 would silently skip the interview.
	const questions = Number(flags.questions);
	if (Number.isInteger(questions) && questions > 0) parsed.questions = questions;
	return parsed;
}

/**
 * Reads leading flags off a command line, in any order.
 *
 * Only the given names are consumed: an unknown `--flag` stays in the text,
 * because in free prose it may simply *be* the text. `=` and a space both
 * separate a value, like everywhere in pi.
 *
 * A name in `switches` takes no value and arrives as `"true"`. Which list a
 * name is in has to be decided here rather than guessed from what follows it:
 * in `--worktree add a cache`, `add` is the request and not the flag's value.
 */
export function parseLeadingFlags(
	args: string,
	names: readonly string[],
	switches: readonly string[] = [],
): { flags: Record<string, string>; rest: string } {
	const flags: Record<string, string> = {};
	let rest = args;

	for (;;) {
		// The name first, and an `=value` only if it is written that way. What
		// follows a space is claimed by a valued flag and left alone by a switch.
		const head = /^\s*--([a-z]+)(?:=(\S+))?/i.exec(rest);
		const name = head?.[1]?.toLowerCase();
		if (!head || !name) break;

		if (switches.includes(name)) {
			flags[name] = head[2] === "false" ? "false" : "true";
			rest = rest.slice(head[0].length);
			continue;
		}
		if (!names.includes(name)) break;

		const valued = /^\s*--[a-z]+(?:=|\s+)(\S+)\s*/i.exec(rest);
		if (!valued?.[1]) break;
		flags[name] = valued[1];
		rest = rest.slice(valued[0].length);
	}

	return { flags, rest: rest.trim() };
}

/**
 * A switch that can be left unsaid.
 *
 * `--worktree` is `true`, `--worktree=false` is `false`, and absent is
 * `undefined` - which is not the same as `false` any more: it is what lets the
 * workflow decide from the plan it just made. Coercing it here is how the
 * default would be lost on its way through a command.
 */
export function switchValue(flags: Record<string, string>, name: string): boolean | undefined {
	const raw = flags[name];
	return raw === undefined ? undefined : raw === "true";
}

/** Notifies and returns `undefined` - the shape every refusal in these commands has. */
export function refuse(ctx: CommandCtx, message: string, level: "info" | "warning" | "error"): undefined {
	ctx.ui.notify(message, level);
	return undefined;
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
export function choosePipeline(wanted: string | undefined, ctx: CommandCtx, deps: BuildDeps, command = "build"): Pipeline {
	const catalogue = (deps.loadPipelines ?? loadPipelines)({ cwd: ctx.cwd, scope: "both", builtin: true });
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
