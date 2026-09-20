/**
 * `orchestrate`: 1 → ?. An agent *decides* the split, then the split runs.
 *
 * How that decision is read - and why it is a parsed convention rather than a
 * tool call - lives in `plan.ts`. What is left here is the shape: plan, fan out
 * over it, optionally synthesise.
 */

import type { Agent } from "./../agent.ts";
import type { Result } from "./../result.ts";
import type { Usage } from "./../usage.ts";
import { fanOut } from "./fan-out.ts";
import { makePlan, type PlannedTask, type PlanOptions } from "./plan.ts";
import { reduce } from "./reduce.ts";
import { Trail } from "./trail.ts";

/** {@link PlanOptions}, plus how the planned subtasks are run and folded. */
export type OrchestrateOptions = PlanOptions & {
	/** Subtasks in flight at once, as in {@link fanOut}. Defaults to 4. */
	concurrency?: number;
	/** When given, this agent turns the subtask results into one answer. */
	reduceWith?: Agent;
};

/** The plan, what it produced, and optionally the one answer it was folded into. */
export type OrchestrateResult = {
	/** What the planner asked for, after validation. Empty when planning failed. */
	plan: PlannedTask[];
	/** The planner's own turn. Kept whatever happened next. */
	planning: Result;
	/** One result per planned subtask, in plan order. */
	results: Result[];
	/** The synthesis, present only when `reduceWith` was given. */
	answer?: Result;
	/** Aggregate over planning, subtasks and synthesis. `wallMs` is the whole run. */
	usage: Usage;
	/** False when the planning failed or produced nothing runnable. */
	ok: boolean;
	/** Set if and only if `ok` is false. */
	error?: string;
};

/**
 * Asks an agent to split the work, then runs the split it asked for.
 *
 * This is a **dynamic** fan-out: unlike {@link fanOut}, nobody wrote the tasks
 * in advance. Everything else is the same machinery - bounded concurrency, one
 * subagent per branch, no shared state - because a plan the model wrote deserves
 * no more trust than a plan the caller wrote, and a good deal less latitude.
 */
export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
	// The rest **is** the WorkflowOptions the sub-workflows take: destructuring
	// this way means a new common option reaches them without a line of code
	// here, and this combinator's own options never leak into them.
	const { planner, workers, input, concurrency, maxTasks, reduceWith, parse, format, ...shared } = options;
	// Three workflows, three pools, one trail: the planner's turn, every branch
	// and the synthesis are what this orchestration cost.
	const trail = new Trail();

	const done = (planning: Result, plan: PlannedTask[], results: Result[], answer?: Result, error?: string): OrchestrateResult => {
		const broken = trail.broken();
		return {
			plan,
			planning,
			results,
			answer,
			usage: trail.usage(),
			ok: !error && !broken,
			error: error ?? broken?.error,
		};
	};

	// Nothing is spawned beyond the planner until the whole plan has been
	// validated: an unknown agent name or an oversized plan costs one turn, not
	// twenty sessions.
	const planned = await makePlan(options);
	trail.record(planned.planning);
	if (!planned.ok) return done(planned.planning, [], [], undefined, planned.error);

	const { results } = await fanOut({
		...shared,
		concurrency,
		agents: planned.plan.map((step) => step.agent),
		tasks: planned.plan.map((step) => step.task),
	});
	for (const result of results) trail.record(result);

	if (!reduceWith) return done(planned.planning, planned.plan, results);

	const answer = trail.record(await reduce({ ...shared, agent: reduceWith, results, input }));
	return done(planned.planning, planned.plan, results, answer);
}
