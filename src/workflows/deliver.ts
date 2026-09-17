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
 *
 * And why a {@link Verify} on top of the audit: in a real run a pair wrote a
 * helper with its tests, the reviewer approved and the auditor approved, while
 * the test file imported `./slugify.js` for a file named `slugify.ts` - the
 * suite never even loaded. Reading code is not running it. When a verification
 * is given, **its verdict is final**: no amount of approval makes a failing
 * check a success.
 */

import type { Agent } from "./../agent.ts";
import { createLedger, openList, type Ledger, type Obligation } from "./../ledger.ts";
import { failed, type Result } from "./../result.ts";
import { saysWord } from "./../text.ts";
import { emptyUsage, sumUsage, type Usage } from "./../usage.ts";
import type { BuildProgress } from "./../resume.ts";
import { declaresVerdict, lastVerdict, verdictTool, type Verdict } from "./../verdict.ts";
import type { Verification, Verify } from "./../verify.ts";
import type { ToolDefinition } from "./../session.ts";
import { mapConcurrent, SubagentPool, type WorkflowOptions } from "./common.ts";
import { pair, type PairResult } from "./pair.ts";
import { makePlan, parsePlan, type PlannedTask } from "./plan.ts";

/** The word the auditor says when the whole thing holds together. */
export const AUDIT_APPROVAL = "APPROVED";

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
	 * These workers write to the same working tree. Two at a time is already the
	 * point where "independent subtasks" stops being a promise the planner can
	 * keep, and a caller who knows their tasks are truly disjoint can raise it.
	 */
	concurrency?: number;
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

/** One audit and whatever it asked for. */
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
		resume,
		onProgress,
		...shared
	} = options;

	const startedAt = performance.now();
	const audits: AuditRound[] = [...(resume?.audits ?? [])];
	let tasks: PairResult[] = [];
	let verification: Verification | undefined = resume?.verification;

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
			obligations: ledger.all,
			// A failing check outranks every opinion above it, and an obligation
			// nobody closed outranks the auditor's own yes.
			approved: signedOff && ledger.settled && verification?.ok !== false,
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

	const run = (step: PlannedTask) => pair({ ...shared, worker: step.agent, reviewer, input: step.task, maxRounds });

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
	verification = await verify?.();
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
		const fixes = approved || !review.ok ? [] : fixesFrom(review, workers, raised);

		const results = fixes.length > 0 ? await mapConcurrent(fixes, concurrency, run) : [];
		audits.push({ review, verdict, verification, approved, fixes, results });
		tasks = [...tasks, ...results];
		if (results.length > 0) verification = await verify?.();
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

type AuditOptions = WorkflowOptions & {
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
async function auditOnce(options: AuditOptions): Promise<Result> {
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
 */
function fixesFrom(review: Result, workers: readonly Agent[], raised: readonly string[] = []): PlannedTask[] {
	// What the tool carries wins when it carries anything: those lines are what
	// the auditor put on the ledger, so acting on the prose instead would work
	// from something nobody is going to be asked about again.
	const source = raised.length ? raised.join("\n") : review.output;
	const named = parsePlan(source, workers);
	if (named.length > 0 || workers.length !== 1) return named;

	const only = workers[0] as Agent;
	const remarks = source.trim();
	return remarks ? [{ agent: only, task: `The audit asked for this. Address it:\n\n${remarks}` }] : [];
}

/** `APPROVED` on a line of its own, whatever decoration the model added. */
function isApproved(output: string): boolean {
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
						? ""
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
