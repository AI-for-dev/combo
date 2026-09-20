/**
 * What a command reaches for, and the real thing each one stands in for.
 *
 * The only bugs that ever reached a user through this extension were in the
 * wiring, and wiring is only testable when it can be handed doubles. So every
 * command takes its dependencies as an argument - and resolves them **once**,
 * here, rather than choosing between the double and the real thing at every
 * use. A command reads `deps.runPipeline` and never asks which it is.
 */

import {
	checkModel,
	commitAll,
	createBranch,
	createRunDir,
	diff,
	diffStat,
	findResumableBuild,
	interview,
	isRepository,
	loadAgents,
	loadPipelines,
	run,
	runPipeline,
	saveBuildState,
	status,
	swarm,
	untracked,
	type Verify,
} from "../src/index.ts";

/** Everything a command reaches for, injectable. Defaults are the real thing. */
export type CommandDeps = {
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
	git?: Git;
	/** Where transcripts land. Defaults to a fresh `runs/<timestamp>/`. */
	runDir?: () => string;
	/**
	 * The project's own check. Stays optional once resolved: absent means
	 * nobody said, and the command decides what that means for it.
	 */
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

/** The git a command performs its acts through. */
export type Git = {
	isRepository: typeof isRepository;
	status: typeof status;
	diff: typeof diff;
	diffStat: typeof diffStat;
	untracked: typeof untracked;
	createBranch: typeof createBranch;
	commitAll: typeof commitAll;
};

/** The real git, and the default of every `deps.git`. */
export const REAL_GIT: Git = { isRepository, status, diff, diffStat, untracked, createBranch, commitAll };

/**
 * {@link CommandDeps} with every gap filled: what a command actually runs with.
 *
 * `verify` and `tickMs` keep their optionality on purpose - for them, absent is
 * an answer and not a gap.
 */
export type Deps = Required<Omit<CommandDeps, "verify" | "tickMs">> & Pick<CommandDeps, "verify" | "tickMs">;

/**
 * Fills what the caller left unsaid with the real thing.
 *
 * A key holding `undefined` counts as unsaid: a caller that builds its deps by
 * merging hands us `{ runDir: undefined }` for an option nobody set, and an
 * explicit `undefined` spread over a default would silently win.
 */
export function resolved(deps: CommandDeps = {}): Deps {
	const said = Object.fromEntries(Object.entries(deps).filter(([, value]) => value !== undefined));
	return {
		loadAgents,
		loadPipelines,
		interview,
		runPipeline,
		run,
		swarm,
		git: REAL_GIT,
		runDir: () => createRunDir(),
		findResumable: findResumableBuild,
		saveState: saveBuildState,
		checkModel,
		...said,
	};
}
