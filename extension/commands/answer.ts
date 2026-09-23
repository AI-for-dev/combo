/**
 * The answer a finished run leaves in the conversation, and how it is told
 * apart there: `/run`'s, and a step `/quote` puts there.
 *
 * The model reads the answer and one line on how the run ended; the person
 * also sees the run's last frame, which the message carries in its details
 * for the renderer and never hands to the model. The `subagent` tool and a
 * flow stage of `/step` tell how a run ended with the same pieces.
 */

import * as path from "node:path";
import { livePlan, readJournal, resumePoint, type CheckedFlow, type FlowResult, type JournalEntry, type LivePlan } from "../../src/index.ts";
import type { MessageDeps } from "../deps.ts";
import type { CommandCtx } from "../pi.ts";
import { framed } from "../relay.ts";

/**
 * `customType` of the message a finished run leaves in the session, and of a
 * step `/quote` puts there.
 *
 * A custom message rather than a user one - see `SendMessage` for the three
 * doors pi offers and why this is the only one that fits. pi converts it to
 * the **user** role on the way to the model, so the content carries a header
 * naming what ran: read as something the user typed, an unattributed report
 * is confusing; read as a quoted result, it is exactly right. The string
 * predates flows, and stays so the sessions that hold it still draw.
 */
export const RESULT_MESSAGE = "pipeline-result";

/** What a {@link RESULT_MESSAGE} carries beside its text, for the renderer. */
export type ResultDetails = {
	/** What ran: the flow, or `chain` for a quoted step. */
	readonly name: string;
	/** The steps of a chain, in order. */
	readonly steps?: readonly string[];
	/** Where the run left its state and its exports. */
	readonly runDir?: string;
	/** The run's last frame, drawn under the answer and never read by the model. */
	readonly live?: LivePlan;
};

/**
 * The run's answer, into the conversation: the output of its last root node
 * and one line on how it ended, for the model and the person alike; and its
 * last frame, drawn beneath for the person only.
 */
export function answer(ctx: Pick<CommandCtx, "cwd">, doors: MessageDeps, checked: CheckedFlow, input: unknown, runDir: string, result: FlowResult): void {
	const { output, end, live } = flowAnswer(ctx, checked, runDir, result);
	const details: ResultDetails = { name: checked.name, runDir, live };
	doors.sendMessage({
		customType: RESULT_MESSAGE,
		content: `${framed(`the \`${checked.name}\` flow`, asText(input), output)}\n\n${end}`.replace(/\n{3,}/g, "\n\n"),
		display: true,
		details,
	});
}

/** How a flow run ended, as every launch tells it: its output, one line on how it ended, and its last frame. */
export type FlowAnswer = { readonly output: string; readonly end: string; readonly live: LivePlan };

/** What the run in `runDir` of `checked` answered, read back from its journal once it ended. */
export function flowAnswer(ctx: Pick<CommandCtx, "cwd">, checked: CheckedFlow, runDir: string, result: FlowResult): FlowAnswer {
	const journal = readJournal(runDir);
	return { output: result.ok ? asText(result.output) : "", end: endLine(ctx, checked, journal, runDir, result), live: livePlan(checked, journal, []) };
}

/**
 * `ok · runs/…`, with `converged` or `not converged` when the last root node
 * is a loop; or where it failed and why, then what a resume would do.
 */
function endLine(ctx: Pick<CommandCtx, "cwd">, checked: CheckedFlow, journal: readonly JournalEntry[], runDir: string, result: FlowResult): string {
	const dir = shown(ctx, runDir);
	if (result.ok) {
		const last = checked.nodes.at(-1);
		const end = journal.findLast((entry) => entry.type === "visit_end" && entry.path === last?.id);
		const converged = last?.kind === "loop" && end?.type === "visit_end" ? [end.converged === false ? "not converged" : "converged"] : [];
		return ["ok", ...converged, dir].join(" · ");
	}
	return [failure(result), dir, resumeHint(ctx, checked, journal, runDir)].join(" · ");
}

/** Where a failed run failed and why: `failed at answer: provider: …`. */
export function failure(result: Extract<FlowResult, { ok: false }>): string {
	return `failed at ${result.path === "" ? "its start" : result.path}: ${result.error.kind}: ${result.error.message}`;
}

/** What `/run resume` would do with the run in `runDir`, or why it cannot. */
export function resumeHint(ctx: Pick<CommandCtx, "cwd">, checked: CheckedFlow, journal: readonly JournalEntry[], runDir: string): string {
	const point = resumePoint(checked, journal);
	return point.ok ? `/run resume ${shown(ctx, runDir)} picks it up at ${point.from === "" ? "its end" : point.from}` : `it cannot be resumed: ${point.refused}`;
}

/** A value as the conversation reads it: text as it is, anything else as JSON. */
export function asText(value: unknown): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** `runDir` as the person reads it: from the working directory. */
export function shown(ctx: Pick<CommandCtx, "cwd">, runDir: string): string {
	return path.relative(ctx.cwd, runDir) || ".";
}
