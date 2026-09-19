/**
 * The audit: one agent reads the whole of a delivery, and says what is left.
 *
 * Why an audit on top of per-task reviews: a reviewer sees one subtask and
 * approves it in good faith. Nobody sees the seams - two subtasks that each did
 * half the job, or the same helper written twice under two names. That is what
 * the auditor reads for, and it is the reason it gets the whole brief rather
 * than a task.
 *
 * One round is one throwaway subagent: the second audit must read the code as
 * it is now, not remember how it was talked into approving the first time. What
 * carries between rounds is the ledger, never a context.
 *
 * This file holds the round and the prompt behind it. Composing the rounds into
 * a delivery - plan, pairs, check, fixes - is `deliver.ts`.
 */

import type { Agent } from "./../agent.ts";
import { openList, type Obligation } from "./../ledger.ts";
import { failed, type Result } from "./../result.ts";
import type { ToolDefinition } from "./../session.ts";
import { saysWord } from "./../text.ts";
import type { Verdict } from "./../verdict.ts";
import type { Verification } from "./../verify.ts";
import { SubagentPool, type WorkflowOptions } from "./common.ts";
import type { PairResult } from "./pair.ts";
import { parsePlan, type PlannedTask } from "./plan.ts";

/** The word the auditor says when the whole thing holds together. */
export const AUDIT_APPROVAL = "APPROVED";

/** One pass of the audit cycle: what was said, what it cost, what was fixed. */
export type AuditRound = {
	/** The auditor's turn, in full. It is the evidence behind `approved`. */
	review: Result;
	/** What the auditor declared through the verdict tool, when it holds one. */
	verdict?: Verdict;
	/** The check as it stood when this audit ran, when there is one. */
	verification?: Verification;
	/** Whether this round signed off. A failing check makes it `false` whatever the prose. */
	approved: boolean;
	/** The fixes the auditor asked for, as it named them. */
	fixes: PlannedTask[];
	/** What came back from those fixes. */
	results: PairResult[];
};

/** One round's cast, and everything it is asked to account for. */
export type AuditOptions = WorkflowOptions & {
	auditor: Agent;
	/** Who the auditor may hand a fix to. It has to know their names. */
	workers: readonly Agent[];
	brief: string;
	tasks: readonly PairResult[];
	verification?: Verification;
	round: number;
	maxAuditRounds: number;
	/** Obligations still open, which this round is asked to answer for by id. */
	open: readonly Obligation[];
	/** Offered when the auditor declares it. The collector outlives this turn. */
	verdictTool?: ToolDefinition;
};

/** One audit turn, on its own throwaway subagent. */
export async function auditOnce(options: AuditOptions): Promise<Result> {
	const { auditor, workers, brief, tasks, verification, round, maxAuditRounds, open, signal, timeoutMs, ...rest } =
		options;
	const { verdictTool: tool, ...shared } = rest;

	if (signal?.aborted) return failed(auditor.name, "aborted");

	// A fresh auditor every round on purpose: the second audit must read the
	// code as it is now, not remember how it was talked into approving. The
	// ledger is what carries between rounds instead.
	const pool = new SubagentPool({ ...shared, lifetime: "task", customTools: tool ? () => [tool] : undefined });
	try {
		const subagent = await pool.acquire(auditor, auditor.name);
		try {
			const prompt = auditPrompt(brief, tasks, round, maxAuditRounds, verification, workers, { open, byTool: !!tool });
			return await subagent.ask(prompt, { signal, timeoutMs });
		} finally {
			await pool.release(subagent);
		}
	} finally {
		await pool.closeAll();
	}
}

/**
 * What the auditor asked for, in the plan convention - with one concession.
 *
 * An auditor that refuses in prose is refusing all the same. Observed: a check
 * failed, the auditor explained the fix in three lines of English and named
 * nobody, and the run stopped on a correct diagnosis nobody acted on. So when
 * exactly **one** worker could take it, the whole review is handed to them:
 * there is no ambiguity to resolve. With several workers there is, and dropping
 * it stays right - guessing who owns a fix is how the wrong file gets rewritten.
 *
 * That concession is for prose and for prose only. An auditor holding the
 * verdict tool has a place to put what it wants done, and `byTool` says it did;
 * reading its prose as well turned the word `APPROVED` into a fix a coder was
 * sent away to make.
 */
export function fixesFrom(
	review: Result,
	workers: readonly Agent[],
	raised: readonly string[],
	byTool: boolean,
): PlannedTask[] {
	if (byTool) return parsePlan(raised.join("\n"), workers);

	const named = parsePlan(review.output, workers);
	if (named.length > 0 || workers.length !== 1) return named;

	const only = workers[0] as Agent;
	const remarks = review.output.trim();
	return remarks ? [{ agent: only, task: `The audit asked for this. Address it:\n\n${remarks}` }] : [];
}

/**
 * A fix, with the check that was standing when the auditor asked for it.
 *
 * Measured: the check passed with four green tests, the auditor then wrote
 * "test file has a syntax error causing failure" and raised a fix for it, and a
 * round was spent rewriting a file that was fine. The auditor was holding that
 * check's output in its own prompt and contradicted it anyway, which is
 * invariant 7 in its usual form - a prompt is not a permission boundary.
 *
 * Dropping the fix would need us to read the auditor's prose for a claim about
 * the check, and a guess there throws away real remarks. So the evidence
 * travels with the work instead: a worker sent after a failure that is not
 * there can settle it by reading, rather than by rewriting.
 *
 * Only a **passing** check is attached. A failing one is what the fix is for,
 * and the worker meets it the moment it runs the suite.
 */
export function withCheck(task: string, verification?: Verification): string {
	if (!verification?.ok) return task;
	return [
		task,
		"",
		`Before you change anything: the project's check (\`${verification.command ?? "check"}\`) passes on this tree.`,
		"If what you were asked to fix is that something fails, nothing does - say so, and change nothing.",
	].join("\n");
}

/** `APPROVED` on a line of its own, whatever decoration the model added. */
export function isApproved(output: string): boolean {
	return saysWord(output, AUDIT_APPROVAL);
}

/** How the auditor is asked to answer, and what it still owes. */
export type AuditPromptOptions = {
	/** Obligations still open, which it is asked to answer for by id. */
	open?: readonly Obligation[];
	/** Whether the auditor decides through the `verdict` tool. */
	byTool?: boolean;
};

/** What the auditor reads: the brief, what each subtask claims, and what is owed. */
export function auditPrompt(
	brief: string,
	tasks: readonly PairResult[],
	round: number,
	maxAuditRounds: number,
	verification?: Verification,
	workers: readonly Agent[] = [],
	options: AuditPromptOptions = {},
): string {
	const owed = options.open ?? [];
	const reports = tasks
		.map((task, index) => {
			const state = task.ok ? (task.approved ? "reviewed and approved" : "reviewed, NOT approved") : `failed: ${task.error}`;
			return `## ${index + 1}. ${task.agent} (${state})\n${task.output.trim() || "(no output)"}`;
		})
		.join("\n\n");

	return [
		round === 1 ? "The work below is finished. Audit it as a whole." : `Audit the work again - round ${round}.`,
		"",
		"Each part was reviewed on its own. What nobody has looked at is the seams:",
		"the same thing done twice under two names, a part of the brief nobody took,",
		"two parts that contradict each other, or work that was reported but not done.",
		"Read the code; the reports below are claims, not evidence.",
		"",
		"The specification:",
		brief.trim(),
		"",
		"What was reported:",
		reports || "(nothing was done)",
		"",
		verification
			? [
					`The project's own check was run (\`${verification.command ?? "check"}\`) and ${verification.ok ? "passed" : "FAILED"}:`,
					verification.output || "(no output)",
					verification.ok
						? "A passing check is evidence too. Ask for a fix because the code is wrong, not because something fails: whoever takes the fix is handed this same result and reads it before touching anything."
						: "A failing check is not an opinion. Whatever else you find, the fixes must make it pass.",
					"",
				]
					.filter(Boolean)
					.join("\n")
			: "",
		owed.length ? "Still open, from your earlier rounds:" : "",
		owed.length ? openList(owed) : "",
		owed.length ? "" : "",
		options.byTool
			? "Call the `verdict` tool. Put your fix lines in `raised`, and name in `resolved` every id above you are done with: one you leave out stays open, and the work is not finished while anything is."
			: `Answer ${AUDIT_APPROVAL} alone if the whole thing holds together.`,
		"",
		options.byTool
			? "Each fix line takes this exact form:"
			: "Otherwise answer with nothing but fix lines, one per line, in this exact form:",
		`    ${workers[0]?.name ?? "coder"}: what to do`,
		workers.length ? `The only names you may use: ${workers.map((agent) => agent.name).join(", ")}.` : "",
		"Write the name literally - `agent:` is not a name and the line will be thrown away.",
		"No prose around the lines: each one is sent on its own to the agent it names, which sees",
		"nothing else - not this audit, not the other fixes.",
		round >= maxAuditRounds ? "This is the last audit: ask only for what genuinely matters." : "",
	]
		.filter(Boolean)
		.join("\n");
}
