/**
 * The interactive commands: `/interview`, and `/build` on top of it.
 *
 * These are **commands**, not tools, and that is a design decision rather than a
 * convenience: the interview owns the terminal for the length of each question,
 * and nobody can answer a question that is being asked inside a model's turn.
 * A tool the model calls could never do this.
 *
 * `/build` is the whole flow - interview, plan, worker↔reviewer pairs, audit,
 * commit - and it stops at three points to ask: the brief before any work
 * starts, the commit before anything is written to history, and nothing else.
 * Everything between those is the library's, unchanged and injectable.
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
	deliver,
	diff,
	diffStat,
	findAgent,
	interview,
	isRepository,
	loadAgents,
	run,
	status,
	untracked,
	usageReport,
	writeUsageReport,
	type Agent,
	type DeliverResult,
	type InterviewResult,
	type Verify,
} from "../src/index.ts";
import { createAskUi, type AskUi } from "./ask-ui.ts";
import { paintWidget } from "./execute.ts";

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
	interview?: typeof interview;
	deliver?: typeof deliver;
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

export default function registerCommands(pi: ExtensionAPI) {
	pi.registerCommand("interview", {
		description: "Turn a vague request into a brief, one question at a time",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runInterview(args, ctx as unknown as CommandCtx);
		},
	});

	pi.registerCommand("build", {
		description: "Interview, plan, build with worker/reviewer pairs, audit, then commit",
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
export async function runBuild(request: string, ctx: CommandCtx, deps: BuildDeps = {}): Promise<DeliverResult | undefined> {
	const git = deps.git ?? REAL_GIT;
	if (!request.trim()) {
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
	let cast: { planner: Agent; workers: Agent[]; reviewer: Agent; auditor: Agent; committer: Agent };
	try {
		cast = {
			planner: findAgent(agents, CAST.planner),
			workers: CAST.workers.map((name) => findAgent(agents, name)),
			reviewer: findAgent(agents, CAST.reviewer),
			auditor: findAgent(agents, CAST.auditor),
			committer: findAgent(agents, CAST.committer),
		};
	} catch (cause) {
		ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
		return undefined;
	}

	const interviewed = await runInterview(request, ctx, deps);
	if (!interviewed?.ok) return undefined;

	const start = await ctx.ui.confirm("Build this?", firstLines(interviewed.brief, 12));
	if (!start) {
		ctx.ui.notify("build: stopped before any work started - the brief is in the editor", "info");
		return undefined;
	}

	// The bar the agents cannot talk their way past. Asked for once, here,
	// because only the user knows what "it works" means in their project - and
	// an empty answer is a legitimate "there is nothing to run".
	const verify = deps.verify ?? (await askForCheck(ctx));

	// A pipeline that writes code leaves its transcripts behind: when something
	// went wrong, "what did the coder actually see" is the first question.
	const exportDir = (deps.runDir ?? createRunDir)();
	const collector = createTuiCollector();
	const onEvent = combineReporters(collector.reporter, createHerdrReporter());

	// The same dots the tool draws: one painter, so the two flows cannot drift.
	const paint = () => ctx.ui.setWidget?.(STATUS, paintWidget(collector.snapshot(), ctx.ui.theme));
	collector.onChange(paint);
	const tickMs = deps.tickMs ?? 250;
	const tick = tickMs > 0 ? setInterval(paint, tickMs) : undefined;
	tick?.unref?.();

	let built: DeliverResult | undefined;
	ctx.ui.setStatus(STATUS, "building…");
	try {
		built = await (deps.deliver ?? deliver)({
			...cast,
			brief: interviewed.brief,
			cwd: ctx.cwd,
			exportDir,
			verify,
			signal: ctx.signal,
			onEvent,
		});
	} finally {
		if (tick) clearInterval(tick);
		ctx.ui.setStatus(STATUS, undefined);
		ctx.ui.setWidget?.(STATUS, undefined);
		writeRunReport(exportDir, collector, built);
	}

	const check = built.verification ? `, check ${built.verification.ok ? "passed" : "FAILED"}` : "";
	ctx.ui.notify(
		`${built.tasks.length} subtask(s), ${built.audits.length} audit(s)${check}, ${built.approved ? "approved" : "NOT approved"} - exported to ${exportDir}`,
		built.approved ? "info" : "warning",
	);

	await submit(request, interviewed.brief, built, cast.committer, ctx, deps);
	return built;
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
	built: DeliverResult,
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
		ctx.ui.notify(`build: no commit - the work is in the working tree, ${built.approved ? "audited" : "NOT audited"}`, "info");
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
function writeRunReport(dir: string, collector: ReturnType<typeof createTuiCollector>, built: DeliverResult | undefined): void {
	try {
		writeUsageReport(dir, usageReport(collector.snapshot(), built?.usage.wallMs ?? 0));
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
