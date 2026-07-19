/**
 * `deliver`: a brief in, work done and audited out.
 *
 * Plan the split, run each subtask as a worker↔reviewer {@link pair}, then have
 * one auditor read the whole thing and send back what still needs fixing. It is
 * the composition the rest of this library was built for, and it adds exactly
 * one idea of its own: **the audit**.
 *
 * Why an audit on top of per-task reviews: a reviewer sees one subtask and
 * approves it in good faith. Nobody sees the seams - two subtasks that each did
 * half the job, or the same helper written twice under two names. That is what
 * the auditor reads for, and it is the reason it gets the whole brief rather
 * than a task.
 */

import type { Agent } from "./../agent.ts";
import { failed, type Result } from "./../result.ts";
import { sumUsage, type Usage } from "./../usage.ts";
import { mapConcurrent, SubagentPool, type WorkflowOptions } from "./common.ts";
import { pair, type PairResult } from "./pair.ts";
import { makePlan, parsePlan, type PlannedTask } from "./plan.ts";

/** The word the auditor says when the whole thing holds together. */
export const AUDIT_APPROVAL = "APPROVED";

export type DeliverOptions = WorkflowOptions & {
	/** Splits the brief into subtasks. */
	planner: Agent;
	/** Who may be assigned a subtask. Their `description` is what the planner reads. */
	workers: Agent[];
	/** Reviews every subtask, paired with its worker. */
	reviewer: Agent;
	/** Reads the finished whole and asks for what is missing. Optional. */
	auditor?: Agent;
	/** The specification. Usually an {@link interview}'s brief. */
	brief: string;
	maxTasks?: number;
	/**
	 * Subtasks in flight at once. Defaults to **2**, not 4.
	 *
	 * These workers write to the same working tree. Two at a time is already the
	 * point where "independent subtasks" stops being a promise the planner can
	 * keep, and a caller who knows their tasks are truly disjoint can raise it.
	 */
	concurrency?: number;
	/** Rounds inside each pair. Defaults to 3. */
	maxRounds?: number;
	/** Audit → fix → re-audit cycles. Defaults to 2. */
	maxAuditRounds?: number;
};

/** One audit and whatever it asked for. */
export type AuditRound = {
	review: Result;
	approved: boolean;
	/** The fixes the auditor asked for, as it named them. */
	fixes: PlannedTask[];
	/** What came back from those fixes. */
	results: PairResult[];
};

export type DeliverResult = {
	brief: string;
	plan: PlannedTask[];
	planning: Result;
	/** One per planned subtask, in plan order. */
	tasks: PairResult[];
	audits: AuditRound[];
	/** Whether the auditor signed off. `true` with no auditor at all. */
	approved: boolean;
	usage: Usage;
	/** Every turn ran without a model error. Says nothing about quality - read `approved`. */
	ok: boolean;
	error?: string;
};

/**
 * Plans, builds, reviews and audits.
 *
 * Failures never throw: a subtask whose pair failed comes back in `tasks` with
 * `ok: false`, and the rest carries on. What stops everything is a plan that
 * could not be made - there is nothing to distribute.
 *
 * `approved` and `ok` answer different questions, as everywhere else here: `ok`
 * says the turns ran, `approved` says the auditor was satisfied. A run that
 * exhausts `maxAuditRounds` with every turn technically fine is
 * `ok: true, approved: false`.
 */
export async function deliver(options: DeliverOptions): Promise<DeliverResult> {
	const {
		planner,
		workers,
		reviewer,
		auditor,
		brief,
		maxTasks,
		concurrency = 2,
		maxRounds,
		maxAuditRounds = 2,
		...shared
	} = options;

	const startedAt = performance.now();
	const audits: AuditRound[] = [];
	let tasks: PairResult[] = [];

	const outcome = (plan: PlannedTask[], planning: Result, approved: boolean, error?: string): DeliverResult => {
		const usages = [planning.usage, ...tasks.map((task) => task.usage)];
		for (const round of audits) {
			usages.push(round.review.usage, ...round.results.map((result) => result.usage));
		}
		const broken = [...tasks, ...audits.flatMap((round) => round.results)].find((result) => !result.ok);
		return {
			brief,
			plan,
			planning,
			tasks,
			audits,
			approved,
			usage: sumUsage(usages, performance.now() - startedAt),
			ok: !error && planning.ok && !broken,
			error: error ?? broken?.error ?? planning.error,
		};
	};

	const planned = await makePlan({ ...shared, planner, workers, input: brief, maxTasks });
	if (!planned.ok) return outcome([], planned.planning, false, planned.error);

	const run = (step: PlannedTask) => pair({ ...shared, worker: step.agent, reviewer, input: step.task, maxRounds });
	tasks = await mapConcurrent(planned.plan, concurrency, run);

	if (!auditor) return outcome(planned.plan, planned.planning, true);

	for (let round = 1; round <= maxAuditRounds; round++) {
		if (shared.signal?.aborted) break;

		const review = await auditOnce({ ...shared, auditor, brief, tasks, round, maxAuditRounds });
		const approved = !review.ok ? false : isApproved(review.output);
		// The auditor names who fixes what, in the plan convention: one parser,
		// one vocabulary. A name it invented is dropped, like anywhere else.
		const fixes = approved || !review.ok ? [] : parsePlan(review.output, workers);

		const results = fixes.length > 0 ? await mapConcurrent(fixes, concurrency, run) : [];
		audits.push({ review, approved, fixes, results });
		tasks = [...tasks, ...results];

		if (approved) return outcome(planned.plan, planned.planning, true);
		// Nothing actionable came back: another identical audit would only cost
		// tokens.
		if (results.length === 0) break;
	}

	return outcome(planned.plan, planned.planning, false);
}

type AuditOptions = WorkflowOptions & {
	auditor: Agent;
	brief: string;
	tasks: readonly PairResult[];
	round: number;
	maxAuditRounds: number;
};

/** One audit turn, on its own throwaway subagent. */
async function auditOnce(options: AuditOptions): Promise<Result> {
	const { auditor, brief, tasks, round, maxAuditRounds, signal, timeoutMs, ...shared } = options;

	if (signal?.aborted) return failed(auditor.name, "aborted");

	// A fresh auditor every round on purpose: the second audit must read the
	// code as it is now, not remember how it was talked into approving.
	const pool = new SubagentPool({ ...shared, lifetime: "task" });
	try {
		const subagent = await pool.acquire(auditor, auditor.name);
		try {
			return await subagent.ask(auditPrompt(brief, tasks, round, maxAuditRounds), { signal, timeoutMs });
		} finally {
			await pool.release(subagent);
		}
	} finally {
		await pool.closeAll();
	}
}

/** `APPROVED` on a line of its own, whatever decoration the model added. */
function isApproved(output: string): boolean {
	return output
		.trim()
		.split("\n")
		.some((line) => line.replace(/[*_`#\s.]/g, "").toUpperCase() === AUDIT_APPROVAL);
}

/** What the auditor reads: the brief, then what each subtask claims it did. */
export function auditPrompt(brief: string, tasks: readonly PairResult[], round: number, maxAuditRounds: number): string {
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
		`Answer ${AUDIT_APPROVAL} alone if the whole thing holds together.`,
		"Otherwise list only what still has to change, one line per fix, as `agent: what to do`.",
		round >= maxAuditRounds ? "This is the last audit: ask only for what genuinely matters." : "",
	]
		.filter(Boolean)
		.join("\n");
}
