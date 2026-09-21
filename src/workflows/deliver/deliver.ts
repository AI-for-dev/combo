/**
 * `deliver`: a brief in, work done and audited out.
 *
 * Plan the split, run each subtask as a worker↔reviewer {@link pair}, then have
 * one auditor read the whole thing and send back what still needs fixing. It is
 * the composition the rest of this library was built for: plan, work, audit,
 * settle. The audit cycle lives next door in `audit.ts` and how the work
 * reaches the tree in `settle.ts`; what this file holds is the order they
 * happen in, and what a resumed run keeps of a previous one.
 *
 * Why a {@link Verify} on top of the audit: in a real run a pair wrote a
 * helper with its tests, the reviewer approved and the auditor approved, while
 * the test file imported `./slugify.js` for a file named `slugify.ts` - the
 * suite never even loaded. Reading code is not running it. When a verification
 * is given, **its verdict is final**: no amount of approval makes a failing
 * check a success.
 */

import type { Agent } from "../../agent.ts";
import { notify } from "../../events.ts";
import type { Landed } from "../../land.ts";
import { joinOutputs, succeeded, type Result, type WorkflowResult } from "../../result.ts";
import { sumUsage } from "../../usage.ts";
import type { Verify } from "../../verify.ts";
import { audit, type AuditProgress } from "./audit.ts";
import { mapConcurrent } from "../concurrent.ts";
import type { WorkflowOptions } from "../options.ts";
import { pair, type PairResult } from "./pair.ts";
import { makePlan, type PlannedTask } from "../plan.ts";
import { settling, type Settling } from "./settle.ts";

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
	 * Two at a time is already the point where "independent subtasks" stops being
	 * a promise the planner can keep, and a copy per pair does not change that:
	 * what it bounds is the filesystem, not the plan. The limit is now what a run
	 * costs rather than what the tree allows, and a caller can raise it knowingly.
	 */
	concurrency?: number;
	/**
	 * Give each subtask a copy of the repository, and put the work back after.
	 *
	 * Every pair runs in a git worktree of `cwd`, and what they wrote is applied
	 * to `cwd` one patch at a time with `verify` run between them, so a patch that
	 * breaks the tree is named rather than bisected.
	 *
	 * **Defaulted from the plan**: a plan with more than one subtask gets the
	 * copies, a plan with one does not. Left unset it is decided after planning,
	 * which is the first moment the number is known; `true` and `false` are
	 * obeyed as written.
	 *
	 * The default is that way round because a shared directory is not only a race
	 * between two writers, it is a **channel between them**. Measured: four
	 * subagents given one directory each read the other three's files inside a
	 * single turn, without being asked to look. A delivery of one subtask has
	 * nobody to leak to and stays where it was told to write, which is what
	 * `/build` on your own repository is for.
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
	 * Called after the plan, after the subtasks and after every audit round,
	 * with where the build stands and whether it has reached its end.
	 *
	 * This is what makes a build resumable at all: the caller writes it down. It
	 * is a reporting hook, so it must not throw - a listener that does is
	 * swallowed, like everywhere else here.
	 */
	onProgress?: (progress: BuildProgress, done: boolean) => void;
};

/**
 * Where a build stands: what `deliver` reports as it goes, and what it accepts
 * to start again from.
 *
 * The audit cycle's own progress, plus the plan it works from. One shape for
 * the three moments it is read at - reported after every unit of work, saved
 * by whoever runs the build, handed back on resume - so nothing is copied
 * between them field by field, and a saved build carries what a live one does.
 */
export type BuildProgress = AuditProgress & {
	/** The subtasks, with their agents resolved. Reused on resume, never made again. */
	plan: PlannedTask[];
};

/**
 * Everything a delivery produced, and the two words that say whether it counts.
 *
 * The build's progress as it ended, plus what only the end can say. As a
 * `Result`: the planner's turn, with every subtask's output labelled where its
 * own would be. `steps` is what the delivery paid for - the planning, every
 * subtask as a pair's result, every audit's review - and `usage` is their sum
 * over the run, fixes included since the audit puts them among the tasks. `ok`
 * says every turn ran and nothing about quality: read `approved`.
 */
export type DeliverResult = WorkflowResult &
	BuildProgress & {
	/** The specification the delivery worked from, as given. */
	brief: string;
	/** The planner's own turn. Kept whatever happened next. */
	planning: Result;
	/**
	 * What became of the copies' patches, one entry per batch that ran.
	 *
	 * Empty when the subtasks shared the tree. A batch that stopped on a patch names it, and
	 * `approved` is false while any of these is: work that never reached the tree
	 * is not delivered, whatever the auditor thought of the reports.
	 */
	landings: readonly Landed[];
	/**
	 * Whether the work passed the bar: the auditor signed off, **nothing it
	 * raised is still open**, and the check passed. `true` with neither an
	 * auditor nor a check - there was no bar.
	 */
	approved: boolean;
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
		maxAuditRounds,
		verify,
		worktree,
		resume,
		onProgress,
		...shared
	} = options;

	const startedAt = performance.now();
	// Where the build stands. A resumed run carries in the plan it paid for, the
	// audits it spent and what the auditor raised, which stand until an auditor
	// moves them; its subtasks come back only once approved, below.
	let progress: BuildProgress = {
		plan: resume?.plan ?? [],
		tasks: [],
		audits: resume?.audits ?? [],
		obligations: resume?.obligations ?? [],
		verification: resume?.verification,
	};
	// Set once the plan says how many will write; until then, nothing landed.
	let tree: Settling | undefined;

	// A reporting hook is an observer, like a reporter on the event bus.
	const report = (done = false) => notify(onProgress, progress, done);

	const outcome = (planning: Result, signedOff: boolean, error?: string): DeliverResult => {
		const { tasks, audits, obligations, verification } = progress;
		// The fixes are in `tasks` already, so a round's own cost is its review.
		const steps = [planning, ...tasks, ...audits.map((round) => round.review)];
		const broken = tasks.find((result) => !result.ok);
		return {
			...planning,
			output: joinOutputs(tasks),
			steps,
			brief,
			...progress,
			planning,
			landings: tree?.landings ?? [],
			// A failing check outranks every opinion above it, an obligation nobody
			// closed outranks the auditor's own yes, and work that never reached
			// the tree is not delivered whatever was said about the reports.
			approved: signedOff && obligations.every((one) => one.closed) && verification?.ok !== false && (tree?.landed ?? true),
			usage: sumUsage(
				steps.map((step) => step.usage),
				performance.now() - startedAt,
			),
			ok: !error && planning.ok && !broken,
			error: error ?? broken?.error ?? planning.error,
		};
	};

	// A resumed build keeps the plan it already paid for. Re-planning would also
	// re-split work that is half done in the working tree.
	const planned = resume?.plan.length
		? { ok: true as const, plan: resume.plan, planning: reusedPlanning(planner, resume.plan) }
		: await makePlan({ ...shared, planner, workers, input: brief, maxTasks });
	if (!planned.ok) return outcome(planned.planning, false, planned.error);
	progress = { ...progress, plan: planned.plan };
	report();

	// Decided here because here is where the number of writers is first known,
	// and refused here when the tree cannot take what it would have to take back.
	const ready = await settling({ cwd: shared.cwd ?? process.cwd(), worktree, writers: planned.plan.length, verify });
	if (!ready.ok) return outcome(planned.planning, false, ready.error);
	tree = ready.value;

	const run = (step: PlannedTask) =>
		pair({ ...shared, worker: step.agent, reviewer, input: step.task, maxRounds, worktree: tree?.isolate });

	// Only what was **approved** survives a resume: a subtask still being argued
	// over left the tree in a state nobody signed off on, so it runs again.
	const kept = new Map((resume?.tasks ?? []).filter((task) => task.approved).map((task) => [task.input, task]));
	const todo = planned.plan.filter((step) => !kept.has(step.task));
	const done = await mapConcurrent(todo, concurrency, run);

	const byTask = new Map(done.map((task) => [task.input, task]));
	progress = {
		...progress,
		tasks: planned.plan.flatMap((step) => {
			const task = kept.get(step.task) ?? byTask.get(step.task);
			return task ? [task] : [];
		}),
		verification: await tree.settle(done),
	};
	report();

	if (!auditor) {
		report(true);
		return outcome(planned.planning, true);
	}

	// The audit says what must change; this is how it reaches the tree. What
	// the cycle reports is the build's progress minus the plan, so it lands in
	// one spread.
	const audited = await audit({
		...shared,
		auditor,
		workers,
		brief,
		tasks: progress.tasks,
		verification: progress.verification,
		maxAuditRounds,
		resume,
		fix: async (fixes) => {
			const results = await mapConcurrent(fixes, concurrency, run);
			return { results, verification: await ready.value.settle(results) };
		},
		onRound: (round) => {
			progress = { ...progress, ...round };
			report();
		},
	});
	progress = { ...progress, ...audited.progress };

	report(true);
	return outcome(planned.planning, audited.approved);
}

/**
 * A stand-in for the planning turn a resumed build did not run.
 *
 * `ok: true` because the plan is real - it was made, and paid for, by the run
 * being continued. The output says so rather than pretending to be model text.
 */
function reusedPlanning(planner: Agent, plan: readonly PlannedTask[]): Result {
	return succeeded(planner.name, `(plan reused from an interrupted run)\n${plan.map((step) => `${step.agent.name}: ${step.task}`).join("\n")}`);
}
