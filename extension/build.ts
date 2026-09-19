/**
 * `/build`: the whole flow, and the state machine that walks it.
 *
 * A **command**, not a tool, and that is a design decision rather than a
 * convenience: the interview it opens with owns the terminal for the length of
 * each question, and nobody can answer a question that is being asked inside a
 * model's turn. A tool the model calls could never do this.
 *
 * Interview, then a **pipeline**, then the commit, stopping exactly twice to
 * ask: the brief before any work starts, the commit before anything is written
 * to history, and nothing else. The two stops are the two files beside this
 * one, `interview-command.ts` and `commit.ts`; what this file holds is the
 * order they happen in and what is checked before any of them does.
 *
 * What runs between those two stops is not hard-coded here: it is a pipeline
 * file, the user's own `build.md` if they wrote one and a built-in default
 * otherwise. The default is itself a pipeline, parsed by the same parser and
 * run by the same runner, so there is exactly one code path and nothing to
 * drift. The interview and the commit stay out of it deliberately: a question
 * card owns the terminal, and "the agent writes the message, this code makes
 * the commit" is a boundary a file must not be able to move.
 *
 * Project agents are loaded here (`scope: "both"`). A user typing `/build` in a
 * repository *is* the explicit request the rule asks for - what must never
 * happen is loading them behind their back.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	checkModel,
	createRunDir,
	commandVerifier,
	findResumableBuild,
	fromBuildState,
	findAgent,
	checkPipelineAgents,
	missingAgents,
	plural,
	runPipeline,
	saveBuildState,
	toBuildState,
	type Agent,
	type BuildProgress,
	type BuildState,
	type DeliverResult,
	type Pipeline,
	type PipelineRunOptions,
	type PipelineRunResult,
	type Verify,
} from "../src/index.ts";
import { submit } from "./commit.ts";
import { runInterview } from "./interview-command.ts";
import {
	choosePipeline,
	firstLines,
	loadRoster,
	parseBuildArgs,
	refuse,
	REAL_GIT,
	type BuildDeps,
	type CommandCtx,
} from "./command.ts";
import { liveRun, pipelineVerifier, STATUS } from "./run-ui.ts";

/**
 * Registers `/build`.
 *
 * A command rather than a tool, and that is not a style choice: the interview it
 * opens with owns the terminal until each question is answered, and nobody can
 * answer a question asked inside a model's turn.
 */
export default function registerBuildCommand(pi: ExtensionAPI) {
	pi.registerCommand("build", {
		description:
			"Interview, run the build pipeline, then commit (`--pipeline <name>`, `--model <pattern>`, `--worktree`, `--questions <n>`, or `resume` to carry on)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runBuild(args, ctx as unknown as CommandCtx);
		},
	});
}

/** Which agent plays which part. Names, so a user can substitute their own. */
const CAST = {
	planner: "planner",
	reviewer: "reviewer",
	auditor: "auditor",
	committer: "committer",
	/** Everyone the planner may delegate to. */
	workers: ["coder"],
} as const;

/**
 * `/build <request>` - the whole flow, with three stops.
 *
 * Interview → **confirm the brief** → plan, pairs, audit → **confirm the
 * commit** → branch and commit. Nothing else asks, and nothing irreversible
 * happens without one of those two answers.
 *
 * A refusal at either stop leaves everything exactly where it is: the brief is
 * still in the editor, the work is still in the working tree. Nothing is undone
 * on the user's behalf.
 */
export async function runBuild(args: string, ctx: CommandCtx, deps: BuildDeps = {}): Promise<PipelineRunResult | undefined> {
	const plan = await validateBuild(args, ctx, deps);
	if (!plan) return undefined;

	// One run, one folder - and it is made before the interview rather than
	// after it. An interview that fails used to leave nothing to read, which is
	// the one moment "what was actually sent" is the only question worth asking.
	const exportDir = plan.previous ? plan.previous.dir : (deps.runDir ?? createRunDir)();

	const started = await loadOrResume(plan, ctx, deps, exportDir);
	if (!started) return undefined;

	if (!(await confirmBrief(started, ctx))) {
		return refuse(ctx, "build: stopped before any work started - the brief is in the editor", "info");
	}

	const ran = await runTheWork(plan, started, exportDir, ctx, deps);

	// The last delivery is what a human acts on. A pipeline with no `deliver`
	// step has no `approved` to report, and saying "NOT approved" about a run
	// that was never audited would be a lie about the work.
	const built = ran.done.steps.map((step) => step.delivery).filter(Boolean).at(-1);
	report(ran.done, built, ran.exportDir, ctx);

	await submit(ran.label, started.brief, built?.approved ?? ran.done.ok, plan.committer, ctx, deps);
	return ran.done;
}

/** What a build needs settled before anybody is asked anything. */
type BuildPlan = {
	git: typeof REAL_GIT;
	agents: Agent[];
	pipeline: Pipeline;
	/** The agent that writes the commit message. Resolved early: it is needed last. */
	committer: Agent;
	model?: string;
	/** Whether each subtask gets a copy of the repository. See `--worktree`. */
	worktree?: boolean;
	/** How many questions the interview may ask. See `--questions`. */
	questions?: number;
	/** What the user typed, minus the flags. */
	request: string;
	/** The interrupted build being carried on, when this is a `/build resume`. */
	previous?: { dir: string; state: BuildState };
};

/**
 * Everything a mistake can cost, spent before the interview.
 *
 * The repository, the roster, the pipeline, the cast and `--model` are all
 * checked while the only thing at stake is the user's next second - not the
 * conversation they would otherwise have sat through first.
 */
async function validateBuild(args: string, ctx: CommandCtx, deps: BuildDeps): Promise<BuildPlan | undefined> {
	const git = deps.git ?? REAL_GIT;
	const { pipeline: wanted, model, worktree, questions, request } = parseBuildArgs(args);

	// `/build resume` carries on the last interrupted build in this directory:
	// same brief, same plan, the approved subtasks kept. Everything the workers
	// already wrote is still in the working tree, so redoing it would be paying
	// twice and overwriting what a reviewer already accepted.
	let previous: { dir: string; state: BuildState } | undefined;
	if (request.trim().toLowerCase() === "resume") {
		previous = (deps.findResumable ?? findResumableBuild)("runs", ctx.cwd);
		if (!previous) return refuse(ctx, "build: no interrupted build to carry on here", "warning");
	} else if (!request.trim()) {
		return refuse(ctx, "build: say what you want built, for example /build add a cache to the loader", "warning");
	}

	if (!(await git.isRepository(ctx.cwd))) {
		// Not pedantry: the whole point of the last step is that the work lands
		// on a branch of its own, and there is no branch without a repository.
		return refuse(ctx, "build: this is not a git repository - the work would have nowhere to land", "error");
	}

	const agents = loadRoster(ctx, deps);
	try {
		const pipeline = choosePipeline(wanted, ctx, deps);
		checkPipelineAgents(pipeline, agents);
		const committer = findAgent(agents, CAST.committer);
		// Same reasoning as the lines above: a mistyped model must cost a second,
		// not the interview it would otherwise sit through first.
		if (model) await (deps.checkModel ?? checkModel)(model);
		return { git, agents, pipeline, committer, model, worktree, questions, request, previous };
	} catch (cause) {
		return refuse(ctx, cause instanceof Error ? cause.message : String(cause), "error");
	}
}

/** The brief a run starts from, and the progress it carries on with. */
type StartingPoint = { brief: string; resume?: BuildProgress };

/**
 * Where the work starts: the saved brief and progress, or a fresh interview.
 *
 * A resumed build is never re-interviewed - that would ask the user to decide
 * again what they decided an hour ago.
 */
async function loadOrResume(
	plan: BuildPlan,
	ctx: CommandCtx,
	deps: BuildDeps,
	exportDir: string,
): Promise<StartingPoint | undefined> {
	const previous = plan.previous;
	if (!previous) {
		const outcome = await runInterview(plan.request, ctx, deps, {
			model: plan.model,
			maxQuestions: plan.questions,
			exportDir,
		});
		return outcome?.brief ? { brief: outcome.brief } : undefined;
	}

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
	return { brief: previous.state.brief, resume };
}

/** The first of the two stops: the brief, before anything runs. */
async function confirmBrief(started: StartingPoint, ctx: CommandCtx): Promise<boolean> {
	const resume = started.resume;
	const kept = resume?.tasks.filter((task) => task.approved).length ?? 0;
	return await ctx.ui.confirm(
		resume ? `Carry on? ${kept}/${plural(resume.plan.length, "subtask")} already approved` : "Build this?",
		firstLines(started.brief, 12),
	);
}

/** The work itself: the check, the transcripts, the progress saves, the dots. */
async function runTheWork(
	plan: BuildPlan,
	started: StartingPoint,
	exportDir: string,
	ctx: CommandCtx,
	deps: BuildDeps,
): Promise<{ done: PipelineRunResult; exportDir: string; label: string }> {
	const { previous, pipeline, agents, model } = plan;
	const { brief } = started;
	const label = previous ? previous.state.request : plan.request.trim();

	// The bar the agents cannot talk their way past. A pipeline that names its
	// own check has already stated it, once, in a file; otherwise the user is
	// asked, because only they know what "it works" means in their project - and
	// an empty answer is a legitimate "there is nothing to run".
	const verify = deps.verify ?? pipelineVerifier(pipeline, ctx.cwd) ?? (await askForCheck(ctx));

	// The same dots the tool draws, and the same ones `/run` draws.
	const live = liveRun(ctx.ui, { tickMs: deps.tickMs, signal: ctx.signal });

	let done: PipelineRunResult | undefined;
	ctx.ui.setStatus(STATUS, "building…");
	try {
		done = await (deps.runPipeline ?? runPipeline)({
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
		});
	} finally {
		live.stop(exportDir, done?.usage.wallMs ?? 0);
	}

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
	deps: BuildDeps,
): NonNullable<PipelineRunOptions["delivery"]> {
	const save = deps.saveState ?? saveBuildState;
	const { previous } = plan;
	const about = { request: where.label, brief: started.brief, cwd: ctx.cwd, startedAt: previous?.state.startedAt };

	return {
		// A two-delivery pipeline must not hand the second step the first one's
		// approved subtasks.
		resume: (stepId) =>
			started.resume && (previous?.state.step ?? stepId) === stepId ? started.resume : undefined,
		onProgress: (stepId, progress) => void save(where.exportDir, toBuildState(progress, { ...about, step: stepId })),
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

/**
 * Asks once for the command that says whether the work is good.
 *
 * A prompt cannot make an agent honest about its own work; running the tests
 * can. Nothing is imposed, though: an empty answer means there is nothing to
 * run, and the audit stays the only bar.
 */
async function askForCheck(ctx: CommandCtx): Promise<Verify | undefined> {
	const typed = await ctx.ui.input("Command that checks the work, e.g. npm test (empty: none)", "npm test");
	const parts = typed?.trim().split(/\s+/).filter(Boolean) ?? [];
	if (parts.length === 0) return undefined;
	return commandVerifier({ cwd: ctx.cwd, command: parts[0] as string, args: parts.slice(1) });
}

