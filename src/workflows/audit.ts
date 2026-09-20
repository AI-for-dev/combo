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
 * This file holds the cycle: the rounds, the record of what the auditor asked
 * for, and the prompt behind each round. How a fix reaches the tree is the
 * caller's - `deliver.ts` hands it a function for that.
 */

import type { Agent } from "./../agent.ts";
import { openList, type Obligation } from "./../ledger.ts";
import type { Result } from "./../result.ts";
import { reviewRecord } from "./../review.ts";
import type { ToolDefinition } from "./../session.ts";
import { saysWord } from "./../text.ts";
import { declaresVerdict, type Verdict } from "./../verdict.ts";
import type { Verification } from "./../verify.ts";
import type { WorkflowOptions } from "./options.ts";
import { SubagentPool } from "./pool.ts";
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

/** How a fix the auditor asked for reached the tree, and what the tree is now. */
export type Fixed = {
	/** One per fix, as the caller ran them. */
	results: PairResult[];
	/** The check as it stands after them, when one ran. */
	verification?: Verification;
};

/** The cycle as it stands: what a caller saves after every round. */
export type AuditProgress = {
	/** Every round so far, the ones a previous run recorded first. */
	rounds: readonly AuditRound[];
	/** What was audited last: the subtasks, then every fix that came back. */
	tasks: readonly PairResult[];
	/** What the auditor raised across the rounds, and what became of each. */
	obligations: readonly Obligation[];
	/** The check as it last stood, when one ran. */
	verification?: Verification;
};

/** The cycle, ended: signed off, or not. */
export type AuditResult = AuditProgress & {
	/**
	 * Whether the last round signed off with nothing owed and no failing check
	 * standing. Reaching the cap is not approval, and neither is a yes over a
	 * check that fails.
	 */
	approved: boolean;
};

/** Who audits, what, and how what it asks for gets done. */
export type AuditOptions = WorkflowOptions & {
	/** Reads the whole and says what is left. A fresh one every round. */
	auditor: Agent;
	/** Who the auditor may hand a fix to. It has to know their names. */
	workers: readonly Agent[];
	/** The specification the work is audited against. */
	brief: string;
	/** What is audited: every subtask as it stands when the cycle opens. */
	tasks: readonly PairResult[];
	/** The check as it stood when the cycle opens, when one ran. */
	verification?: Verification;
	/** Audit → fix → re-audit cycles. Defaults to 2. */
	maxAuditRounds?: number;
	/** What a previous run already spent and raised. Resuming continues the cycle, it does not restart it. */
	resume?: Pick<AuditProgress, "rounds" | "obligations">;
	/**
	 * Runs the fixes the auditor asked for, and says what the tree is afterwards.
	 *
	 * The audit says what must change and reads the check that stood after it;
	 * how the work reaches the tree - a pair, a copy of the repository, a landing
	 * - is the caller's, and stays out of here.
	 */
	fix: (fixes: readonly PlannedTask[]) => Promise<Fixed>;
	/** After every round. A reporting hook: one that throws is swallowed. */
	onRound?: (progress: AuditProgress) => void;
};

/**
 * Audits the work as a whole, round after round, until it holds together.
 *
 * Each round is one throwaway auditor reading the brief, every report and the
 * check, then deciding - through the `verdict` tool when its definition names
 * it, in prose otherwise. What it asks for is run through `fix`, with the check
 * that stood when it asked attached, and the next round reads the fixes too.
 *
 * Two things end the cycle before the cap: a yes with nothing owed and no
 * failing check standing; or a round that asked for nothing and closed nothing,
 * because another identical audit would only cost tokens. A yes over a failing
 * check keeps going while rounds are left - the check is the one voice here that
 * cannot be talked round.
 */
export async function audit(options: AuditOptions): Promise<AuditResult> {
	const { auditor, workers, brief, resume, fix, onRound, ...shared } = options;
	const maxAuditRounds = options.maxAuditRounds ?? 2;
	const rounds: AuditRound[] = [...(resume?.rounds ?? [])];
	let tasks: readonly PairResult[] = options.tasks;
	let verification = options.verification;

	// Built once for the cycle although every round gets a fresh auditor: the
	// record is what carries between rounds, never a context.
	const record = reviewRecord(auditor.name, {
		byTool: declaresVerdict(auditor.tools),
		inProse: (review) => isApproved(review.output),
		restored: resume?.obligations,
	});
	const progress = (): AuditProgress => ({ rounds, tasks, obligations: record.all, verification });
	const report = () => {
		try {
			onRound?.(progress());
		} catch {
			// a caller's bookkeeping problem is not the workflow's problem
		}
	};

	// `"task"` whatever the caller runs with: the second audit must read the code
	// as it is now, not remember how it was talked into approving the first time.
	const pool = new SubagentPool({ ...shared, lifetime: "task", customTools: record.tool ? () => [record.tool as ToolDefinition] : undefined });
	try {
		// A resumed run has already spent the rounds it recorded.
		for (let round = rounds.length + 1; round <= maxAuditRounds; round++) {
			if (shared.signal?.aborted) break;

			const prompt = auditPrompt(brief, tasks, round, maxAuditRounds, verification, workers, { open: record.open, byTool: record.byTool });
			const review = await pool.turn(auditor, prompt);
			const { verdict, approved, raised } = await record.close(review, round);

			// The auditor names who fixes what, in the plan convention: one parser,
			// one vocabulary. A name it invented is dropped, like anywhere else.
			const fixes = approved || !review.ok ? [] : fixesFrom(review, workers, raised, record.byTool);
			// The check goes out with the fix, not only with the audit that asked
			// for it: `withCheck` says what that is worth.
			const fixed = fixes.length > 0 ? await fix(fixes.map((one) => ({ ...one, task: withCheck(one.task, verification) }))) : undefined;

			rounds.push({ review, verdict, verification, approved, fixes, results: fixed?.results ?? [] });
			if (fixed) {
				tasks = [...tasks, ...fixed.results];
				verification = fixed.verification;
			}
			report();

			if (approved && verification?.ok !== false) return { ...progress(), approved: true };
			if (!fixed && !(verdict?.resolved.length ?? 0)) break;
		}
	} finally {
		await pool.closeAll();
	}

	return { ...progress(), approved: false };
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
