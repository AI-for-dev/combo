/**
 * `/build`: a pipeline run from the request to a finished working tree, with
 * nobody asked anything on the way.
 *
 * What runs is not hard-coded here: it is a pipeline file, the user's own
 * `build.md` if they wrote one and a built-in default otherwise. The default is
 * itself a pipeline, parsed by the same parser and run by the same runner, so
 * there is exactly one code path and nothing to drift. What this file adds
 * around it is what a run left alone needs: every check before the first
 * spawn, a saved state after every unit of work, and `/build resume`.
 *
 * It ends with the work in the working tree, uncommitted. What reaches history
 * is decided by whoever reads it there.
 *
 * Project agents are loaded here (`scope: "both"`). A user typing `/build` in a
 * repository *is* the explicit request the rule asks for - what must never
 * happen is loading them behind their back.
 */

import {
	fromBuildState,
	checkPipelineAgents,
	missingAgents,
	plural,
	toBuildState,
	type Agent,
	type BuildProgress,
	type BuildState,
	type DeliverResult,
	type Pipeline,
	type PipelineRunOptions,
	type PipelineRunResult,
} from "../../src/index.ts";
import { checked, choosePipeline, checkVerifier, loadRoster, refuse, watched } from "../command.ts";
import type { CommandCtx, PiApi } from "../pi.ts";
import { resolved, type CommandDeps, type Deps } from "../deps.ts";
import { parseBuildArgs } from "../flags.ts";

/** Registers `/build`. */
export default function registerBuildCommand(pi: PiApi) {
	pi.registerCommand("build", {
		description:
			"Run the build pipeline on a request, unattended, and leave the work uncommitted (`--pipeline <name>`, `--model <pattern>`, `--worktree`, `--check \"<command>\"`, or `resume` to carry on)",
		handler: async (args, ctx: CommandCtx) => {
			await runBuild(args, ctx);
		},
	});
}

/**
 * `/build <request>` - the pipeline, then a report of what it amounted to.
 *
 * The request is the brief. Nothing asks: a question in the middle of a run is
 * a run that waits for whoever left it going.
 */
export async function runBuild(args: string, ctx: CommandCtx, injected: CommandDeps = {}): Promise<PipelineRunResult | undefined> {
	const deps = resolved(injected);
	const plan = await validateBuild(args, ctx, deps);
	if (!plan) return undefined;

	const started = startingPoint(plan, ctx);
	if (!started) return undefined;

	// One run, one folder: a resumed build writes where it started.
	const exportDir = plan.previous ? plan.previous.dir : deps.runDir();

	const ran = await runTheWork(plan, started, exportDir, ctx, deps);

	// The last delivery is what a human acts on. A pipeline with no `deliver`
	// step has no `approved` to report, and saying "NOT approved" about a run
	// that was never audited would be a lie about the work.
	const built = ran.done.steps.map((step) => step.delivery).filter(Boolean).at(-1);
	report(ran.done, built, ran.exportDir, ctx);
	return ran.done;
}

/** What a build needs settled before anything is spawned. */
type BuildPlan = {
	agents: Agent[];
	pipeline: Pipeline;
	model?: string;
	/** Whether each subtask gets a copy of the repository. See `--worktree`. */
	worktree?: boolean;
	/** The command that checks the work, as typed after `--check`. */
	check?: string[];
	/** What the user typed, minus the flags. */
	request: string;
	/** The interrupted build being carried on, when this is a `/build resume`. */
	previous?: { dir: string; state: BuildState };
};

/**
 * Everything a mistake can cost, spent before the first spawn.
 *
 * The repository, the roster, the pipeline and `--model` are all checked while
 * the only thing at stake is the user's next second - not a run they would
 * come back to find stopped at its first step.
 */
async function validateBuild(args: string, ctx: CommandCtx, deps: Deps): Promise<BuildPlan | undefined> {
	const { pipeline: wanted, model, worktree, check, request } = parseBuildArgs(args);

	// `/build resume` carries on the last interrupted build in this directory:
	// same brief, same plan, the approved subtasks kept. Everything the workers
	// already wrote is still in the working tree, so redoing it would be paying
	// twice and overwriting what a reviewer already accepted.
	let previous: { dir: string; state: BuildState } | undefined;
	if (request.trim().toLowerCase() === "resume") {
		previous = deps.findResumable("runs", ctx.cwd);
		if (!previous) return refuse(ctx, "build: no interrupted build to carry on here", "warning");
	} else if (!request.trim()) {
		return refuse(ctx, "build: say what you want built, for example /build add a cache to the loader", "warning");
	}

	if (!(await deps.git.isRepository(ctx.cwd))) {
		// Nobody watches the run write, so git is how its work gets read and, if
		// need be, undone. Without it the tree simply changes.
		return refuse(ctx, "build: this is not a git repository - nothing could show or undo what the run wrote", "error");
	}

	const agents = loadRoster(ctx, deps);
	return await checked(ctx, async () => {
		const pipeline = choosePipeline(wanted, ctx, deps);
		checkPipelineAgents(pipeline, agents);
		if (model) await deps.checkModel(model);
		return { agents, pipeline, model, worktree, check, request, previous };
	});
}

/** The brief a run starts from, and the progress it carries on with. */
type StartingPoint = { brief: string; resume?: BuildProgress };

/**
 * Where the work starts: the request as typed, or the saved brief and progress.
 *
 * A resumed build is said out loud rather than asked about: `/build resume` is
 * already the answer, and the line tells whoever comes back what it picked up.
 */
function startingPoint(plan: BuildPlan, ctx: CommandCtx): StartingPoint | undefined {
	const previous = plan.previous;
	if (!previous) return { brief: plan.request.trim() };

	const resume = fromBuildState(previous.state, plan.agents);
	if (!resume) {
		// Naming them is the difference between a message that can be acted on
		// and one that can only be shrugged at: the fix is to bring that agent
		// back, or to start over. The directory is named too - it is where the
		// state and the transcripts of that build are.
		const missing = missingAgents(previous.state, plan.agents);
		const why =
			missing.length > 0
				? `its plan needs ${missing.join(", ")}, and no agent of that name is loaded - the agents no longer match`
				: "it was saved by another version of combo";
		return refuse(ctx, `build: ${previous.dir} cannot be carried on - ${why}`, "error");
	}
	const kept = resume.tasks.filter((task) => task.approved).length;
	ctx.ui.notify(`build: carrying on ${previous.dir}, ${kept}/${plural(resume.plan.length, "subtask")} already approved`, "info");
	return { brief: previous.state.brief, resume };
}

/** The work itself: the check, the transcripts, the progress saves, the dots. */
async function runTheWork(
	plan: BuildPlan,
	started: StartingPoint,
	exportDir: string,
	ctx: CommandCtx,
	deps: Deps,
): Promise<{ done: PipelineRunResult; exportDir: string; label: string }> {
	const { previous, pipeline, agents, model } = plan;
	const { brief } = started;
	const label = previous ? previous.state.request : plan.request.trim();

	// The bar the agents cannot talk their way past. `--check` says it for this
	// run, a pipeline's `verify:` says it for every run of that file, and with
	// neither the audit is the only bar.
	const verify = deps.verify ?? checkVerifier(plan.check, ctx.cwd) ?? checkVerifier(pipeline.verify, ctx.cwd);

	const done = await watched(ctx, deps, {
		status: "building…",
		dir: exportDir,
		work: (live) =>
			deps.runPipeline({
				pipeline,
				agents,
				input: brief,
				cwd: ctx.cwd,
				exportDir,
				verify,
				model,
				worktree: plan.worktree,
				delivery: deliveryWiring(plan, started, { exportDir, label }, ctx, deps),
				signal: live.signal,
				spawn: live.spawn,
				onEvent: live.onEvent,
			}),
	});

	return { done, exportDir, label };
}
/**
 * How a delivery step finds what was already paid for, and where it saves what
 * it pays for next.
 *
 * Both halves carry a subtlety worth stating: a saved step carries on only in
 * the step it belongs to, and progress is written after every unit of work
 * rather than at the end, so whatever kills the process, what was paid for is
 * already on disk.
 */
function deliveryWiring(
	plan: BuildPlan,
	started: StartingPoint,
	where: { exportDir: string; label: string },
	ctx: CommandCtx,
	deps: Deps,
): NonNullable<PipelineRunOptions["delivery"]> {
	const { previous } = plan;
	const about = { request: where.label, brief: started.brief, cwd: ctx.cwd, startedAt: previous?.state.startedAt };

	return {
		// A two-delivery pipeline must not hand the second step the first one's
		// approved subtasks.
		resume: (stepId) =>
			started.resume && (previous?.state.step ?? stepId) === stepId ? started.resume : undefined,
		onProgress: (stepId, progress, done) => void deps.saveState(where.exportDir, toBuildState(progress, { ...about, step: stepId, done })),
	};
}

/** Says what the run amounted to, in the terms the pipeline actually supports. */
function report(done: PipelineRunResult, built: DeliverResult | undefined, exportDir: string, ctx: CommandCtx): void {
	if (!built) {
		ctx.ui.notify(
			`${plural(done.steps.length, "step")}, ${done.ok ? "all ran" : `stopped: ${done.error}`} - exported to ${exportDir}`,
			done.ok ? "info" : "warning",
		);
		return;
	}

	const check = built.verification ? `, check ${built.verification.ok ? "passed" : "FAILED"}` : "";
	if (!built.approved) {
		// The state file is still there and still `done: false` only if the run
		// stopped short; say plainly what carrying on would mean.
		ctx.ui.notify("build: `/build resume` carries this on, keeping the approved subtasks", "info");
	}
	ctx.ui.notify(
		`${plural(built.tasks.length, "subtask")}, ${plural(built.audits.length, "audit")}${check}, ${built.approved ? "approved" : "NOT approved"} - exported to ${exportDir}`,
		built.approved ? "info" : "warning",
	);
}
