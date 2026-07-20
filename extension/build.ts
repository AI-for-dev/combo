/**
 * The interactive commands: `/interview`, and `/build` on top of it.
 *
 * These are **commands**, not tools, and that is a design decision rather than a
 * convenience: the interview owns the terminal for the length of each question,
 * and nobody can answer a question that is being asked inside a model's turn.
 * A tool the model calls could never do this.
 *
 * `/build` is the whole flow - interview, then a **pipeline**, then the commit -
 * and it stops exactly twice to ask: the brief before any work starts, the
 * commit before anything is written to history, and nothing else.
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
	branchName,
	combineReporters,
	commitAll,
	createBranch,
	createHerdrReporter,
	createRunDir,
	commandVerifier,
	createTuiCollector,
	detectHerdr,
	findResumableBuild,
	fromBuildState,
	diff,
	diffStat,
	findAgent,
	interview,
	isRepository,
	checkPipelineAgents,
	findPipeline,
	loadAgents,
	loadPipelines,
	parsePipeline,
	run,
	runPipeline,
	status,
	untracked,
	saveBuildState,
	toBuildState,
	usageReport,
	writeUsageReport,
	type Agent,
	type BuildProgress,
	type BuildState,
	type DeliverResult,
	type InterviewResult,
	type Pipeline,
	type PipelineRunResult,
	type Verify,
} from "../src/index.ts";
import { createAskUi, type AskUi } from "./ask-ui.ts";
import { paintWidget, watchEverything, watchEverythingIs } from "./execute.ts";

/** Key for the footer status shown while an agent is thinking. */
const STATUS = "pi-subagent";

/**
 * Everything these commands reach for, injectable.
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
	/** Runs one throwaway agent - here, the one writing the commit message. */
	run?: typeof run;
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
	/** Widget repaint period. `0` disables the timer - tests want that. */
	tickMs?: number;
};

const REAL_GIT = { isRepository, status, diff, diffStat, untracked, createBranch, commitAll };

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
 * Registers `/interview`, `/build` and `/herdr`.
 *
 * Commands rather than tools, and that is not a style choice: a question card
 * owns the terminal until it is answered, and nobody can answer a question
 * asked inside a model's turn.
 */
export default function registerCommands(pi: ExtensionAPI) {
	pi.registerCommand("interview", {
		description: "Turn a vague request into a brief, one question at a time",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runInterview(args, ctx as unknown as CommandCtx);
		},
	});

	pi.registerCommand("herdr", {
		description: "Watch every subagent in its own herdr split (on | off)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			toggleHerdr(args, ctx as unknown as CommandCtx);
		},
	});

	pi.registerCommand("build", {
		description: "Interview, run the build pipeline, then commit (`--pipeline <name>`, or `resume` to carry on)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runBuild(args, ctx as unknown as CommandCtx);
		},
	});
}

/**
 * `/herdr on|off` - or nothing, to see where it stands.
 *
 * It is a session preference, not a per-call argument: the point is to stop
 * threading `openInHerdr` through every call while debugging a workflow. Outside
 * herdr it still answers, and says plainly that nothing will open - silence
 * would read as a broken command.
 */
export function toggleHerdr(args: string, ctx: CommandCtx): boolean {
	const word = args.trim().toLowerCase();
	const on = word === "on" || word === "all" ? true : word === "off" ? false : watchEverything();

	if (word && word !== "on" && word !== "off" && word !== "all") {
		ctx.ui.notify(`herdr: say on or off (currently ${watchEverything() ? "on" : "off"})`, "warning");
		return watchEverything();
	}

	watchEverythingIs(on);
	const inside = detectHerdr() !== undefined;
	ctx.ui.notify(
		on
			? inside
				? "herdr: every subagent gets its own split"
				: "herdr: on, but pi is not running inside herdr - nothing will open"
			: "herdr: only the subagents that ask for a split get one",
		on && !inside ? "warning" : "info",
	);
	return on;
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
 * The flow `/build` runs when nobody has written one: today's, expressed as data.
 *
 * It exists so there is exactly **one** code path. The command does not have a
 * built-in behaviour *and* a pipeline mode that drifts from it; it has a default
 * file, which a user overrides by writing `build.md` of their own - and which
 * they can read to learn the vocabulary.
 */
export const DEFAULT_BUILD_PIPELINE = `---
name: build
description: Plan the brief, build each subtask as a worker/reviewer pair, check it, then audit
steps:
  - id: work
    deliver: ${CAST.planner}
    workers: [${CAST.workers.join(", ")}]
    reviewer: ${CAST.reviewer}
    auditor: ${CAST.auditor}
---

## work

Deliver what the brief below asks for, and nothing beyond it.
`;

/**
 * `/build [--pipeline <name>] <request>`.
 *
 * A flag rather than a positional word, because a request is free text: any
 * convention that reads the first word as a pipeline name eventually swallows
 * someone's "build fix the parser".
 */
export function parseBuildArgs(args: string): { pipeline?: string; request: string } {
	const match = /^\s*--pipeline(?:=|\s+)(\S+)\s*/.exec(args);
	if (!match) return { request: args.trim() };
	return { pipeline: match[1] as string, request: args.slice(match[0].length).trim() };
}

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
	const git = deps.git ?? REAL_GIT;
	const { pipeline: wanted, request } = parseBuildArgs(args);

	// `/build resume` carries on the last interrupted build in this directory:
	// same brief, same plan, the approved subtasks kept. Everything the workers
	// already wrote is still in the working tree, so redoing it would be paying
	// twice and overwriting what a reviewer already accepted.
	const resuming = request.trim().toLowerCase() === "resume";
	let previous: { dir: string; state: BuildState } | undefined;
	if (resuming) {
		previous = (deps.findResumable ?? findResumableBuild)("runs", ctx.cwd);
		if (!previous) {
			ctx.ui.notify("build: no interrupted build to carry on here", "warning");
			return undefined;
		}
	}

	if (!resuming && !request.trim()) {
		ctx.ui.notify("build: say what you want built, for example /build add a cache to the loader", "warning");
		return undefined;
	}
	if (!(await git.isRepository(ctx.cwd))) {
		// Not pedantry: the whole point of the last step is that the work lands
		// on a branch of its own, and there is no branch without a repository.
		ctx.ui.notify("build: this is not a git repository - the work would have nowhere to land", "error");
		return undefined;
	}

	const agents = (deps.loadAgents ?? loadAgents)({ cwd: ctx.cwd, scope: "both" });

	// Everything a bad file can cost is spent here, before the interview: the
	// pipeline is chosen, parsed and resolved against the roster while the only
	// thing at stake is the user's next second.
	let pipeline: Pipeline;
	let committer: Agent;
	try {
		pipeline = choosePipeline(wanted, ctx, deps);
		checkPipelineAgents(pipeline, agents);
		committer = findAgent(agents, CAST.committer);
	} catch (cause) {
		ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
		return undefined;
	}

	// A resumed build already has its brief: interviewing again would ask the
	// user to re-decide what they decided an hour ago.
	const brief = previous ? previous.state.brief : (await runInterview(request, ctx, deps))?.brief;
	if (!brief) return undefined;

	const resume: BuildProgress | undefined = previous ? fromBuildState(previous.state, agents) : undefined;
	if (previous && !resume) {
		ctx.ui.notify("build: that build cannot be carried on - its agents no longer match", "error");
		return undefined;
	}

	const kept = resume?.tasks.filter((task) => task.approved).length ?? 0;
	const start = await ctx.ui.confirm(
		resume ? `Carry on? ${kept}/${resume.plan.length} subtask(s) already approved` : "Build this?",
		firstLines(brief, 12),
	);
	if (!start) {
		ctx.ui.notify("build: stopped before any work started - the brief is in the editor", "info");
		return undefined;
	}

	const label = previous ? previous.state.request : request.trim();

	// The bar the agents cannot talk their way past. A pipeline that names its
	// own check has already stated it, once, in a file; otherwise the user is
	// asked, because only they know what "it works" means in their project - and
	// an empty answer is a legitimate "there is nothing to run".
	const verify = deps.verify ?? fromPipeline(pipeline, ctx) ?? (await askForCheck(ctx));

	// A pipeline that writes code leaves its transcripts behind: when something
	// went wrong, "what did the coder actually see" is the first question.
	// A resumed build writes into the directory it started in: one run, one
	// folder, whatever it took to finish it.
	const exportDir = previous ? previous.dir : (deps.runDir ?? createRunDir)();
	const save = deps.saveState ?? saveBuildState;
	const startedAt = previous?.state.startedAt;
	const collector = createTuiCollector();
	const onEvent = combineReporters(collector.reporter, createHerdrReporter({ all: watchEverything() }));

	// The same dots the tool draws: one painter, so the two flows cannot drift.
	const paint = () => ctx.ui.setWidget?.(STATUS, paintWidget(collector.snapshot(), ctx.ui.theme));
	collector.onChange(paint);
	const tickMs = deps.tickMs ?? 250;
	const tick = tickMs > 0 ? setInterval(paint, tickMs) : undefined;
	tick?.unref?.();

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
			delivery: {
				// A saved step carries on only in the step it belongs to: a
				// two-delivery pipeline must not hand the second one the first
				// one's approved subtasks.
				resume: (stepId) => (resume && (previous?.state.step ?? stepId) === stepId ? resume : undefined),
				// Written after the plan, after the subtasks and after every audit:
				// whatever kills the process, what was paid for is on disk.
				onProgress: (stepId, progress) =>
					void save(exportDir, toBuildState(progress, { request: label, brief, cwd: ctx.cwd, startedAt, step: stepId })),
			},
			signal: ctx.signal,
			onEvent,
		});
	} finally {
		if (tick) clearInterval(tick);
		ctx.ui.setStatus(STATUS, undefined);
		ctx.ui.setWidget?.(STATUS, undefined);
		writeRunReport(exportDir, collector, done);
	}

	// The last delivery is what a human acts on. A pipeline with no `deliver`
	// step has no `approved` to report, and saying "NOT approved" about a run
	// that was never audited would be a lie about the work.
	const built = done.steps.map((step) => step.delivery).filter(Boolean).at(-1);
	report(done, built, exportDir, ctx);

	await submit(label, brief, built?.approved ?? done.ok, committer, ctx, deps);
	return done;
}

/** Says what the run amounted to, in the terms the pipeline actually supports. */
function report(done: PipelineRunResult, built: DeliverResult | undefined, exportDir: string, ctx: CommandCtx): void {
	if (!built) {
		ctx.ui.notify(
			`${done.steps.length} step(s), ${done.ok ? "all ran" : `stopped: ${done.error}`} - exported to ${exportDir}`,
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
		`${built.tasks.length} subtask(s), ${built.audits.length} audit(s)${check}, ${built.approved ? "approved" : "NOT approved"} - exported to ${exportDir}`,
		built.approved ? "info" : "warning",
	);
}

/**
 * The pipeline this build runs, or a thrown explanation.
 *
 * A **broken** file is refused rather than silently replaced by the default: a
 * `build.md` sitting there and quietly not being used is exactly the failure
 * `findPipeline` exists to make loud.
 */
function choosePipeline(wanted: string | undefined, ctx: CommandCtx, deps: BuildDeps): Pipeline {
	const catalogue = (deps.loadPipelines ?? loadPipelines)({ cwd: ctx.cwd, scope: "both" });
	const name = wanted ?? "build";

	const broken = catalogue.broken.find((one) => one.name === name);
	if (broken) throw new Error(`build: ${broken.filePath} does not parse: ${broken.error}`);

	const found = catalogue.pipelines.find((one) => one.name === name);
	if (found) return found;
	if (wanted) return findPipeline(catalogue, wanted);

	return parsePipeline(DEFAULT_BUILD_PIPELINE, "<built-in>");
}

/** The check a pipeline names, as a port. Absent means the user is asked. */
function fromPipeline(pipeline: Pipeline, ctx: CommandCtx): Verify | undefined {
	const parts = pipeline.verify;
	if (!parts || parts.length === 0) return undefined;
	return commandVerifier({ cwd: ctx.cwd, command: parts[0] as string, args: parts.slice(1) });
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

/**
 * The last step: a message written by an agent, a commit performed by us.
 *
 * The split is the whole safety story - see `src/git.ts`. What the user is shown
 * before answering is the diffstat and the message, because those are the two
 * things they would regret not having read.
 */
async function submit(
	request: string,
	brief: string,
	approved: boolean,
	committer: Agent,
	ctx: CommandCtx,
	deps: BuildDeps,
): Promise<void> {
	const git = deps.git ?? REAL_GIT;
	const dirty = await git.status(ctx.cwd);
	if (!dirty.ok || !dirty.value.trim()) {
		ctx.ui.notify("build: nothing changed on disk, so there is nothing to commit", "warning");
		return;
	}

	const [stat, patch, added] = await Promise.all([git.diffStat(ctx.cwd), git.diff(ctx.cwd), git.untracked(ctx.cwd)]);
	const summary = [stat.ok ? stat.value.trim() : "", added.length ? `new files:\n${added.join("\n")}` : ""].filter(Boolean).join("\n\n");

	ctx.ui.setStatus(STATUS, "writing the commit message…");
	let message: string;
	try {
		const written = await (deps.run ?? run)(committer, commitPrompt(brief, patch.ok ? patch.value : "", added), {
			cwd: ctx.cwd,
			signal: ctx.signal,
		});
		message = written.ok ? written.output.trim() : "";
	} finally {
		ctx.ui.setStatus(STATUS, undefined);
	}

	if (!message) {
		ctx.ui.notify("build: no commit message was produced - the work is still in the working tree", "warning");
		return;
	}

	// The user edits the message before deciding, not after: a message they had
	// to fix afterwards means a rewritten commit.
	const edited = await ctx.ui.editor("Commit message - edit it, or empty it to skip the commit", message);
	const final = edited?.trim();
	if (!final) {
		ctx.ui.notify("build: no commit - everything is still in the working tree", "info");
		return;
	}

	const branch = branchName(request);
	const go = await ctx.ui.confirm(`Commit on ${branch}?`, `${summary}\n\n${firstLines(final, 6)}`);
	if (!go) {
		ctx.ui.notify(`build: no commit - the work is in the working tree, ${approved ? "audited" : "NOT audited"}`, "info");
		return;
	}

	const branched = await git.createBranch(ctx.cwd, branch);
	if (!branched.ok) {
		ctx.ui.notify(`build: could not create ${branch}: ${branched.error}`, "error");
		return;
	}

	const committed = await git.commitAll(ctx.cwd, final);
	if (!committed.ok) {
		ctx.ui.notify(`build: commit failed: ${committed.error}`, "error");
		return;
	}

	ctx.ui.notify(`committed ${committed.value} on ${branch} - nothing was pushed`, "info");
}

/** What the committer reads: the specification, then the diff itself. */
export function commitPrompt(brief: string, patch: string, added: readonly string[]): string {
	return [
		"Write the commit message for the change below.",
		"",
		"What was asked for:",
		brief.trim(),
		"",
		added.length ? `New files:\n${added.join("\n")}\n` : "",
		"The diff:",
		patch.trim() || "(no tracked changes - the change is entirely in the new files above)",
	]
		.filter(Boolean)
		.join("\n");
}

/** `usage.json` beside the transcripts. Never lets an export break a finished run. */
function writeRunReport(dir: string, collector: ReturnType<typeof createTuiCollector>, done: PipelineRunResult | undefined): void {
	try {
		writeUsageReport(dir, usageReport(collector.snapshot(), done?.usage.wallMs ?? 0));
	} catch {
		// an export is an observer of the run, never a participant
	}
}

/** The first `n` lines, for a dialog that must stay readable. */
function firstLines(text: string, n: number): string {
	const lines = text.trim().split("\n");
	return lines.length <= n ? lines.join("\n") : `${lines.slice(0, n).join("\n")}\n…`;
}

/**
 * `/interview <request>` - asks, then hands the brief back to the user.
 *
 * The brief lands in an editor rather than in a notification: it is the one
 * artefact of this command, it is long, and the user is the last person who
 * gets to correct it before anything is built on top of it.
 */
export async function runInterview(request: string, ctx: CommandCtx, deps: BuildDeps = {}): Promise<InterviewResult | undefined> {
	if (!request.trim()) {
		ctx.ui.notify("interview: say what you want built, for example /interview add a cache to the loader", "warning");
		return undefined;
	}
	if (ctx.hasUI === false) {
		ctx.ui.notify("interview: there is nobody to ask outside an interactive session", "error");
		return undefined;
	}

	const agents = (deps.loadAgents ?? loadAgents)({ cwd: ctx.cwd, scope: "both" });
	let interviewer: Agent;
	try {
		interviewer = findAgent(agents, "interviewer");
	} catch (cause) {
		ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
		return undefined;
	}

	ctx.ui.setStatus(STATUS, "interviewing…");
	let result: InterviewResult;
	try {
		result = await (deps.interview ?? interview)({
			agent: interviewer,
			input: request.trim(),
			ask: createAskUi(ctx.ui),
			cwd: ctx.cwd,
			signal: ctx.signal,
		});
	} finally {
		// In a `finally`: a thrown interview must not leave "interviewing…" in
		// the footer for the rest of the session.
		ctx.ui.setStatus(STATUS, undefined);
	}

	if (!result.ok) {
		ctx.ui.notify(`interview failed: ${result.error ?? "unknown error"}`, "error");
		return result;
	}

	const edited = await ctx.ui.editor("Brief - edit it if it got anything wrong", result.brief);
	const brief = edited?.trim() || result.brief;

	// Put it where the user can act on it: the prompt editor. Sending it is
	// their decision, not ours.
	ctx.ui.setEditorText(brief);
	ctx.ui.notify(
		`brief ready: ${result.answers.length} answer(s), ${result.usage.turns} turns${result.submitted ? ", submitted early" : ""}`,
		"info",
	);

	return { ...result, brief };
}
