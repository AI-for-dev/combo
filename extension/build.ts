/**
 * The interactive commands: an interview that ends in a brief.
 *
 * These are **commands**, not tools, and that is a design decision rather than a
 * convenience: the interview owns the terminal for the length of each question,
 * and nobody can answer a question that is being asked inside a model's turn.
 * A tool the model calls could never do this.
 *
 * Project agents are loaded here (`scope: "both"`). A user typing `/interview`
 * in a repository *is* the explicit request the rule asks for - what must never
 * happen is loading them behind their back.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findAgent, interview, loadAgents, type Agent, type InterviewResult } from "../src/index.ts";
import { createAskUi, type AskUi } from "./ask-ui.ts";

/** Key for the footer status shown while an agent is thinking. */
const STATUS = "pi-subagent";

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
	};
};

export default function registerCommands(pi: ExtensionAPI) {
	pi.registerCommand("interview", {
		description: "Turn a vague request into a brief, one question at a time",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runInterview(args, ctx as unknown as CommandCtx);
		},
	});
}

/**
 * `/interview <request>` - asks, then hands the brief back to the user.
 *
 * The brief lands in an editor rather than in a notification: it is the one
 * artefact of this command, it is long, and the user is the last person who
 * gets to correct it before anything is built on top of it.
 */
export async function runInterview(request: string, ctx: CommandCtx): Promise<InterviewResult | undefined> {
	if (!request.trim()) {
		ctx.ui.notify("interview: say what you want built, for example /interview add a cache to the loader", "warning");
		return undefined;
	}
	if (ctx.hasUI === false) {
		ctx.ui.notify("interview: there is nobody to ask outside an interactive session", "error");
		return undefined;
	}

	const agents = loadAgents({ cwd: ctx.cwd, scope: "both" });
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
		result = await interview({
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
