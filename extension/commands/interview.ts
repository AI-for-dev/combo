/**
 * `/interview` - a vague request turned into a brief, one question at a time.
 *
 * A command and not a tool: a question card owns the terminal until it is
 * answered, and nobody can answer a question asked inside a model's turn.
 * `/build` opens with the same interview, which is why this is a function
 * before it is a command.
 */

import { findAgent, plural, type InterviewResult } from "../../src/index.ts";
import { createAskUi } from "../ui/index.ts";
import { checked, loadRoster, refuse, watched } from "../command.ts";
import type { CommandCtx, PiApi } from "../pi.ts";
import { resolved, type CommandDeps } from "../deps.ts";
import { parseBuildArgs } from "../flags.ts";

/** Registers `/interview`. */
export default function registerInterviewCommand(pi: PiApi) {
	pi.registerCommand("interview", {
		description: "Turn a vague request into a brief, one question at a time (`--model <pattern>`, `--questions <n>`)",
		handler: async (args, ctx: CommandCtx) => {
			const { model, questions, request } = parseBuildArgs(args);
			await runInterview(request, ctx, {}, { model, maxQuestions: questions });
		},
	});
}

/**
 * Deadline for one interview turn.
 *
 * The library refuses to pick one, deliberately: it cannot know how long a task
 * should take. A command can, and this one has to. The interviewer reads the
 * repository between questions, pi's agent loop has no step cap, and the person
 * waiting for the next question cannot tell a slow turn from a stuck one.
 *
 * Five minutes is what `NEXT.md` measures these models at - 120s fails roughly
 * half the turns, so a shorter deadline would cut work that was going to finish.
 */
const INTERVIEW_TURN_MS = 300_000;

/**
 * `/interview <request>` - asks, then hands the brief back to the user.
 *
 * The brief lands in an editor rather than in a notification: it is the one
 * artefact of this command, it is long, and the user is the last person who
 * gets to correct it before anything is built on top of it.
 */
export async function runInterview(
	request: string,
	ctx: CommandCtx,
	injected: CommandDeps = {},
	options: { model?: string; maxQuestions?: number; exportDir?: string } = {},
): Promise<InterviewResult | undefined> {
	const deps = resolved(injected);
	if (!request.trim()) {
		return refuse(ctx, "interview: say what you want built, for example /interview add a cache to the loader", "warning");
	}
	if (ctx.hasUI === false) {
		return refuse(ctx, "interview: there is nobody to ask outside an interactive session", "error");
	}

	const interviewer = await checked(ctx, () => findAgent(loadRoster(ctx, deps), "interviewer"));
	if (!interviewer) return undefined;

	const where = options.exportDir ?? deps.runDir();
	// The same live view the pipeline gets. Without it the first turn is half a
	// minute of a frozen status line while the interviewer reads the repository,
	// and a user cannot tell that from a turn that has hung. No `usage.json` of
	// its own, though: an interview is the opening of a run, not a run.
	const result = await watched(ctx, deps, {
		status: "interviewing…",
		dir: undefined,
		work: (live) =>
			deps.interview({
				agent: interviewer,
				input: request.trim(),
				ask: createAskUi(ctx.ui),
				cwd: ctx.cwd,
				signal: live.signal,
				spawn: live.spawn,
				model: options.model,
				maxQuestions: options.maxQuestions,
				timeoutMs: INTERVIEW_TURN_MS,
				onEvent: live.onEvent,
				// The transcript outlives the command, and a failed interview needs it
				// most: it is the only record of what was actually sent.
				exportDir: where,
			}),
	});

	if (!result.ok) {
		ctx.ui.notify(
			`interview failed: ${result.error ?? "unknown error"} - the transcript is in ${where}`,
			"error",
		);
		return result;
	}

	const edited = await ctx.ui.editor("Brief - edit it if it got anything wrong", result.brief);
	const brief = edited?.trim() || result.brief;

	// Put it where the user can act on it: the prompt editor. Sending it is
	// their decision, not ours.
	ctx.ui.setEditorText(brief);
	ctx.ui.notify(
		`brief ready: ${plural(result.answers.length, "answer")}, ${plural(result.usage.turns, "turn")}${result.submitted ? ", submitted early" : ""}`,
		"info",
	);

	return { ...result, brief };
}
