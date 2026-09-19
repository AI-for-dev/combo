/**
 * `deliver`: a brief in, work done and audited out.
 *
 * Plan the split, run each subtask as a worker↔reviewer {@link pair}, then have
 * one auditor read the whole thing and send back what still needs fixing. It is
 * the composition the rest of this library was built for, and it adds exactly
 * one idea of its own: **the audit**, which lives next door in `audit.ts` -
 * here it is a loop over rounds, a ledger and a check.
 *
 * Why a {@link Verify} on top of the audit: in a real run a pair wrote a
 * helper with its tests, the reviewer approved and the auditor approved, while
 * the test file imported `./slugify.js` for a file named `slugify.ts` - the
 * suite never even loaded. Reading code is not running it. When a verification
 * is given, **its verdict is final**: no amount of approval makes a failing
 * check a success.
 */

import type { Agent } from "./../agent.ts";
import { land, type Landed } from "./../land.ts";
import { createLedger, type Ledger, type Obligation } from "./../ledger.ts";
import { failed, type Result } from "./../result.ts";
import { truncate } from "./../text.ts";
import { emptyUsage, sumUsage, type Usage } from "./../usage.ts";
import type { BuildProgress } from "./../resume.ts";
import { declaresVerdict, lastVerdict, verdictTool, type Verdict } from "./../verdict.ts";
import type { Verification, Verify } from "./../verify.ts";
import { auditOnce, fixesFrom, isApproved, type AuditRound } from "./audit.ts";
import { mapConcurrent, SubagentPool, type WorkflowOptions } from "./common.ts";
import { pair, type PairResult } from "./pair.ts";
import { makePlan, type PlannedTask } from "./plan.ts";

/** The cast of a delivery, and every cap that keeps it affordable. */
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
	/** Subtasks the plan may contain. Defaults to 8, and is checked before spawning. */
	maxTasks?: number;
	/**
	 * Subtasks in flight at once. Defaults to **2**, not 4.
	 *
	 * Without `worktree` these workers write to the same tree, and two at a time
	 * is already the point where "independent subtasks" stops being a promise the
	 * planner can keep. With it the limit is what a run costs rather than what the
	 * filesystem allows, and a caller can raise it on that basis.
	 */
	concurrency?: number;
	/**
	 * Give each subtask a copy of the repository, and put the work back after.
	 *
	 * Every pair runs in a git worktree of `cwd`, and what they wrote is applied
	 * to `cwd` one patch at a time with `verify` run between them, so a patch that
	 * breaks the tree is named rather than bisected. Off by default: a delivery
	 * that fits in one tree has no use for the machinery.
	 */
	worktree?: boolean;
	/** Rounds inside each pair. Defaults to 3. */
	maxRounds?: number;
	/** Audit → fix → re-audit cycles. Defaults to 2. */
	maxAuditRounds?: number;
	/**
	 * Runs the project's own check - tests, a build, a linter.
	 *
	 * Optional, because the library cannot know what "it works" means here. When
	 * present it runs after the work and after every fix round, its output goes
	 * to the auditor as evidence, and a failing check makes the run **not
	 * approved** whatever anyone says about it.
	 */
	verify?: Verify;
	/**
	 * What a previous, interrupted run already did.
	 *
	 * The plan is reused as it stands and every **approved** subtask is kept;
	 * everything else is run again. Approval is the only thing worth trusting
	 * from a previous life: a subtask that was still being argued over left the
	 * working tree in a state nobody signed off on.
	 */
	resume?: BuildProgress;
	/**
	 * Called after the plan, after the subtasks and after every audit round.
	 *
	 * This is what makes a build resumable at all: the caller writes it down. It
	 * is a reporting hook, so it must not throw - a listener that does is
	 * swallowed, like everywhere else here.
	 */
	onProgress?: (progress: BuildProgress) => void;
};


/** Everything a delivery produced, and the two words that say whether it counts. */
export type DeliverResult = {
	/** The specification the delivery worked from, as given. */
	brief: string;
	/** The subtasks, after validation against the roster. */
	plan: PlannedTask[];
	/** The planner's own turn. Kept whatever happened next. */
	planning: Result;
	/** One per planned subtask, in plan order. */
	tasks: PairResult[];
	/** The audit rounds that ran, in order. Empty when no auditor was given. */
	audits: AuditRound[];
	/** The last verification, when one was configured. */
	verification?: Verification;
	/**
	 * What became of the copies' patches, one entry per batch that ran.
	 *
	 * Empty without `worktree`. A batch that stopped on a patch names it, and
	 * `approved` is false while any of these is: work that never reached the tree
	 * is not delivered, whatever the auditor thought of the reports.
	 */
	landings: readonly Landed[];
	/**
	 * What the auditor raised across the rounds, and what became of each.
	 *
	 * Empty when the auditor holds no verdict tool. A run that stopped short says
	 * here which lines are open and since which round, which is what
	 * `approved: false` on its own has never been able to say.
	 */
	obligations: readonly Obligation[];
	/**
	 * Whether the work passed the bar: the auditor signed off, **nothing it
	 * raised is still open**, and the check passed. `true` with neither an
	 * auditor nor a check - there was no bar.
	 */
	approved: boolean;
	/** Aggregate over planning, every pair, the audits and the fixes. */
	usage: Usage;
	/** Every turn ran without a model error. Says nothing about quality - read `approved`. */
	ok: boolean;
	/** Set if and only if `ok` is false. */
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
		verify,
		worktree,
		resume,
		onProgress,
		...shared
	} = options;

	const startedAt = performance.now();
	const audits: AuditRound[] = [...(resume?.audits ?? [])];
	let tasks: PairResult[] = [];
	let verification: Verification | undefined = resume?.verification;
	const landings: Landed[] = [];

	// The auditor decides through a tool when its definition asks for one. Built
	// once for the whole delivery, although `auditOnce` spawns a fresh auditor
	// every round: the ledger outlives the agent that writes into it.
	const auditByTool = !!auditor && declaresVerdict(auditor.tools);
	const ledger = createLedger(resume?.obligations);
	const verdicts = auditByTool
		? verdictTool({
				knows: (id) => ledger.open.some((one) => one.id === id),
				open: () => ledger.open.map((one) => one.id),
			})
		: undefined;

	// A reporting hook is an observer: a listener that throws must not take the
	// build down, exactly like a reporter on the event bus.
	const report = (plan: PlannedTask[], done = false) => {
		try {
			onProgress?.({ plan, tasks, audits, obligations: ledger.all, verification, done });
		} catch {
			// a caller's bookkeeping problem is not the workflow's problem
		}
	};

	const outcome = (plan: PlannedTask[], planning: Result, signedOff: boolean, error?: string): DeliverResult => {
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
			verification,
			landings,
			obligations: ledger.all,
			// A failing check outranks every opinion above it, an obligation nobody
			// closed outranks the auditor's own yes, and work that never reached
			// the tree is not delivered whatever was said about the reports.
			approved: signedOff && ledger.settled && verification?.ok !== false && landings.every((one) => one.ok),
			usage: sumUsage(usages, performance.now() - startedAt),
			ok: !error && planning.ok && !broken,
			error: error ?? broken?.error ?? planning.error,
		};
	};

	// A resumed build keeps the plan it already paid for. Re-planning would also
	// re-split work that is half done in the working tree.
	const planned = resume?.plan.length
		? { ok: true as const, plan: resume.plan, planning: reusedPlanning(planner, resume.plan) }
		: await makePlan({ ...shared, planner, workers, input: brief, maxTasks });
	if (!planned.ok) return outcome([], planned.planning, false, planned.error);
	report(planned.plan);

	const run = (step: PlannedTask) =>
		pair({ ...shared, worker: step.agent, reviewer, input: step.task, maxRounds, worktree });

	/**
	 * Runs the check, and first puts the copies' work back when there were any.
	 *
	 * One call rather than two at each of the two places a batch of pairs
	 * finishes: without `worktree` this is the check on its own, exactly as
	 * before, and with it the check is what `land` ran between the patches.
	 */
	const settle = async (batch: readonly PairResult[]) => {
		if (!worktree) {
			verification = await verify?.();
			return;
		}

		const landed = await land(
			shared.cwd ?? process.cwd(),
			// A short label, not the subtask: a report naming three patches by their
			// full text is one nobody reads.
			batch.map((one) => ({ label: truncate(one.input, 60), patch: one.patch ?? "" })),
			// Only the first landing of a delivery meets a tree it did not write.
			// Refusing the later ones would break the option on any audit that
			// asks for a fix.
			{ verify, requireCleanTree: landings.length === 0 },
		);
		landings.push(landed);
		// The last check `land` ran is the tree as it stands. With nothing to land
		// it ran none, and the check still has to be asked.
		verification = landed.checks.at(-1) ?? (await verify?.());
	};

	// Only what was **approved** survives a resume: a subtask still being argued
	// over left the tree in a state nobody signed off on, so it runs again.
	const kept = new Map((resume?.tasks ?? []).filter((task) => task.approved).map((task) => [task.input, task]));
	const todo = planned.plan.filter((step) => !kept.has(step.task));
	const done = await mapConcurrent(todo, concurrency, run);

	const byTask = new Map(done.map((task) => [task.input, task]));
	tasks = planned.plan.flatMap((step) => {
		const task = kept.get(step.task) ?? byTask.get(step.task);
		return task ? [task] : [];
	});
	await settle(done);
	report(planned.plan);

	if (!auditor) {
		report(planned.plan, true);
		return outcome(planned.plan, planned.planning, true);
	}

	// A resumed build has already spent the audit rounds it recorded.
	for (let round = audits.length + 1; round <= maxAuditRounds; round++) {
		if (shared.signal?.aborted) break;

		const open = ledger.open;
		const review = await auditOnce({
			...shared,
			auditor,
			workers,
			brief,
			tasks,
			verification,
			round,
			maxAuditRounds,
			open,
			verdictTool: verdicts?.tool,
		});

		let verdict: Verdict | undefined;
		let raised: string[] = [];
		if (verdicts && review.ok) {
			verdict = lastVerdict(verdicts.take());
			for (const one of verdict?.resolved ?? []) {
				ledger.close(one.id, auditor.name, { how: one.how, reason: one.reason, at: round });
			}
			raised = verdict?.raised ?? [];
			for (const text of raised) ledger.raise(auditor.name, text, round);
		}

		const said = !review.ok ? false : verdicts ? (verdict?.approved ?? false) : isApproved(review.output);
		const approved = said && ledger.settled;
		// The auditor names who fixes what, in the plan convention: one parser,
		// one vocabulary. A name it invented is dropped, like anywhere else.
		const fixes = approved || !review.ok ? [] : fixesFrom(review, workers, raised, !!verdicts);

		const results = fixes.length > 0 ? await mapConcurrent(fixes, concurrency, run) : [];
		audits.push({ review, verdict, verification, approved, fixes, results });
		tasks = [...tasks, ...results];
		if (results.length > 0) await settle(results);
		report(planned.plan);

		// An approval on top of a failing check is not an approval: keep going
		// while there are rounds left, because the check is the one voice here
		// that cannot be talked round.
		if (approved && verification?.ok !== false) {
			report(planned.plan, true);
			return outcome(planned.plan, planned.planning, true);
		}
		// Nothing actionable came back and nothing moved in the ledger: another
		// identical audit would only cost tokens.
		if (results.length === 0 && !(verdict?.resolved.length ?? 0)) break;
	}

	report(planned.plan, true);
	return outcome(planned.plan, planned.planning, false);
}

/**
 * A stand-in for the planning turn a resumed build did not run.
 *
 * `ok: true` because the plan is real - it was made, and paid for, by the run
 * being continued. The output says so rather than pretending to be model text.
 */
function reusedPlanning(planner: Agent, plan: readonly PlannedTask[]): Result {
	return {
		agent: planner.name,
		output: `(plan reused from an interrupted run)\n${plan.map((step) => `${step.agent.name}: ${step.task}`).join("\n")}`,
		messages: [],
		usage: emptyUsage(),
		ok: true,
	};
}
