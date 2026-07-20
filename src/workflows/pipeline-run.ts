/**
 * Running a pipeline: the piece `pipeline.ts` describes and deliberately leaves
 * to someone else.
 *
 * **Our code walks the steps.** That is the whole reason a pipeline is data
 * rather than a paragraph handed to an agent: the order, the caps and the
 * lifetimes are read from a file, not decided by a model at run time. The two
 * places where a model still chooses - `orchestrate` and `route` - are the
 * bounded, parsed ones it already chose in before.
 *
 * Two decisions worth stating, because they are what makes a run reproducible:
 *
 * - **Everything is resolved before anything is spawned.** Every agent name in
 *   every step is looked up first, so a typo in step four costs nothing rather
 *   than costing three steps of real work.
 * - **The dataflow is two named sections.** A step is handed its own prose, the
 *   **request** the pipeline was started on, and the **previous step's output**.
 *   No templating, no `${{ }}`, no reaching back to step two - the moment a run
 *   needs that, it is a TypeScript workflow, not a file.
 *
 *   The request travels the whole way on purpose. It used to reach step one and
 *   stop there, which a real run exposed at once: a synthesiser answered "there
 *   is no question asked in the prompt", because there was not. The same bug
 *   silently starved the shipped `build` pipeline, whose delivery step saw a
 *   scout's report and never the brief.
 *
 * What this file never does is act on the world. `verify` arrives as a port
 * built by the caller: a pipeline names a command, and running one is a decision
 * that belongs to whoever owns the working tree.
 */

import type { Agent } from "../agent.ts";
import { findAgent } from "../agent.ts";
import type { Pipeline, PipelineStep } from "../pipeline.ts";
import type { BuildProgress } from "../resume.ts";
import { failed, type Result } from "../result.ts";
import { sumUsage, type Usage } from "../usage.ts";
import type { Verify } from "../verify.ts";
import { chain } from "./chain.ts";
import type { WorkflowOptions } from "./common.ts";
import { deliver, type DeliverResult } from "./deliver.ts";
import { fanOut } from "./fan-out.ts";
import { loop } from "./loop.ts";
import { orchestrate } from "./orchestrate.ts";
import { pair } from "./pair.ts";
import { reduce } from "./reduce.ts";
import { route } from "./route.ts";

/** What one step produced, kept whole so a report can show the shape of the run. */
export type PipelineStepResult = {
	/** The step's `id`, as written in the file. */
	id: string;
	/** The combinator it named. */
	kind: PipelineStep["kind"];
	/** The step's own result: the last turn of whatever ran. */
	result: Result;
	/**
	 * Every result the step produced, when it produced several.
	 *
	 * This is what a following `reduce` folds. A fan-out's branches are here, in
	 * task order; a single-result step leaves it undefined.
	 */
	results?: Result[];
	/**
	 * A `deliver` step's full outcome, kept rather than flattened.
	 *
	 * `Result` has one boolean, and a delivery has two that mean different
	 * things: every turn ran, and the work passed the bar. Whoever drives the
	 * pipeline - `/build`, above all - needs `approved`, the audits and the
	 * check, and reducing all of that to a paragraph of text would throw away
	 * the only part a human acts on.
	 */
	delivery?: DeliverResult;
};

/** A pipeline run: what each step did, and what the whole thing amounts to. */
export type PipelineRunResult = {
	/** The pipeline's name, so a report says which file this was. */
	pipeline: string;
	/** One entry per step **that ran**. A stopped pipeline is shorter than its file. */
	steps: PipelineStepResult[];
	/** The last step's output - the pipeline's answer. */
	output: string;
	/** Aggregate over every step. `wallMs` is the duration of the run itself. */
	usage: Usage;
	/** Every step ran without a model error. Says nothing about quality. */
	ok: boolean;
	/** Set if and only if `ok` is false. */
	error?: string;
};

/** What running a pipeline needs beyond the shared workflow options. */
export type PipelineRunOptions = WorkflowOptions & {
	/** The parsed, validated pipeline. */
	pipeline: Pipeline;
	/** The roster its step names are resolved against, before anything spawns. */
	agents: Agent[];
	/** What the pipeline is being run on - the request, or a brief. */
	input: string;
	/**
	 * The project's own check, for any `deliver` step.
	 *
	 * A port, not a command line: the pipeline may *name* a command in its
	 * `verify` field, and turning that into something that runs is the caller's
	 * decision, because it is the caller who owns the working tree.
	 */
	verify?: Verify;
	/** Called as each step finishes. A listener that throws is swallowed. */
	onStep?: (step: PipelineStepResult) => void;
	/**
	 * Resuming and reporting for `deliver` steps, keyed by step id.
	 *
	 * The runner knows nothing about `build.json`: it asks whether there is
	 * anything to carry on for *this* step, and says what that step has done so
	 * far. Where that is kept, and what is deemed worth keeping, belongs to the
	 * caller - which is what lets a resumed run stay a decision someone made.
	 */
	delivery?: {
		/** Whatever was already paid for on a previous life of this step, if anything. */
		resume?: (stepId: string) => BuildProgress | undefined;
		/** Called after the plan, after each subtask and after each audit. */
		onProgress?: (stepId: string, progress: BuildProgress) => void;
	};
};

/** Heading of the section carrying the request the pipeline was started on. */
const REQUEST = "## Request";

/**
 * Runs the steps in order, feeding each one the previous one's output.
 *
 * A failing step **stops** the pipeline, exactly as it stops a chain: there is
 * no input left for the next one. What ran is returned as it stands, with
 * `ok: false`. The function throws only on a programming error - an unknown
 * agent name, a `deliver` step with no `verify` port when one is required -
 * and it throws *before* spawning anything.
 */
export async function runPipeline(options: PipelineRunOptions): Promise<PipelineRunResult> {
	const { pipeline, agents, input, verify, onStep, delivery, ...shared } = options;

	// Resolution first, for the whole file: a name that does not exist must cost
	// nothing, and it costs three steps of real work if it is discovered late.
	const resolved = pipeline.steps.map((step) => ({ step, cast: resolveCast(step, agents) }));

	const startedAt = performance.now();
	const done: PipelineStepResult[] = [];
	let previous: Previous | undefined;
	let error: string | undefined;

	for (const { step, cast } of resolved) {
		if (shared.signal?.aborted) {
			error = "aborted";
			break;
		}

		const outcome = await runStep(step, cast, input, previous, { ...shared, verify, delivery });
		done.push(outcome);
		report(onStep, outcome);

		if (!outcome.result.ok) {
			error = `step "${step.id}" (${step.kind}) failed: ${outcome.result.error ?? "unknown error"}`;
			break;
		}
		previous = { id: step.id, output: outcome.result.output, results: outcome.results };
	}

	const wallMs = performance.now() - startedAt;

	return {
		pipeline: pipeline.name,
		steps: done,
		output: done.at(-1)?.result.output ?? "",
		usage: sumUsage(
			done.map((entry) => entry.result.usage),
			wallMs,
		),
		ok: error === undefined,
		error,
	};
}

/**
 * Resolves every agent the pipeline names, or throws on the first unknown one.
 *
 * Exported so a caller can pay that cost **early** - `/build` checks the file
 * before interviewing anyone, so a typo costs a second rather than a
 * conversation. {@link runPipeline} does it again on its own; it is a lookup.
 */
export function checkPipelineAgents(pipeline: Pipeline, agents: Agent[]): void {
	for (const step of pipeline.steps) resolveCast(step, agents);
}

/** The agents a step names, resolved. Throws on the first unknown name. */
function resolveCast(step: PipelineStep, agents: Agent[]): ResolvedCast {
	const one = (name: string) => findAgent(agents, name);
	return {
		agents: step.agents.map(one),
		workers: step.workers?.map(one),
		reviewer: step.reviewer === undefined ? undefined : one(step.reviewer),
		auditor: step.auditor === undefined ? undefined : one(step.auditor),
		destinations: step.destinations?.map(one),
		fallback: step.fallback === undefined ? undefined : one(step.fallback),
	};
}

type ResolvedCast = {
	agents: Agent[];
	workers?: Agent[];
	reviewer?: Agent;
	auditor?: Agent;
	destinations?: Agent[];
	fallback?: Agent;
};

/** What the step before this one produced. */
type Previous = {
	/** Its `id`, so the section that carries its output can name it. */
	id: string;
	/** Its last output - the material a `chain`-like step works from. */
	output: string;
	/** Its branches, when it had several. This is what a `reduce` folds. */
	results?: Result[];
};

/**
 * What a step is actually asked, in named sections.
 *
 * The prose first, because it is the instruction; then the request, which every
 * step gets - a step that only ever sees the previous output cannot tell what
 * the run was for; then that previous output, labelled with the step it came
 * from. Empty parts are dropped rather than left as a heading with nothing
 * under it.
 */
export function stepInput(prompt: string, request: string, previous?: { id: string; output: string }): string {
	const parts = [prompt.trim()];
	if (request.trim()) parts.push(`${REQUEST}\n\n${request.trim()}`);
	if (previous?.output.trim()) parts.push(`## Output of step \`${previous.id}\`\n\n${previous.output.trim()}`);
	return parts.filter(Boolean).join("\n\n");
}

async function runStep(
	step: PipelineStep,
	cast: ResolvedCast,
	request: string,
	previous: Previous | undefined,
	shared: WorkflowOptions & Pick<PipelineRunOptions, "verify" | "delivery">,
): Promise<PipelineStepResult> {
	const { verify, delivery, ...workflow } = shared;
	const common = {
		...workflow,
		lifetime: step.lifetime ?? workflow.lifetime,
		openInHerdr: step.openInHerdr ?? workflow.openInHerdr,
		timeoutMs: step.timeoutMs ?? workflow.timeoutMs,
	};
	const text = stepInput(step.prompt, request, previous);
	const entry = (result: Result, results?: Result[], built?: DeliverResult): PipelineStepResult => ({
		id: step.id,
		kind: step.kind,
		result,
		results,
		delivery: built,
	});

	switch (step.kind) {
		case "chain": {
			const done = await chain({ ...common, steps: cast.agents, input: text });
			return entry(done, done.steps);
		}

		case "fanOut": {
			// `agents` is either one for every branch or one per task: the shape
			// was checked when the file was parsed, so this cannot be undefined.
			const tasks = (step.tasks as string[]).map((task) => stepInput(`${step.prompt}\n\n${task}`, request, previous));
			const done = await fanOut({
				...common,
				agent: cast.agents.length === 1 ? cast.agents[0] : undefined,
				agents: cast.agents.length === 1 ? undefined : cast.agents,
				tasks,
				concurrency: step.concurrency,
				failFast: step.failFast,
			});
			const last = done.results.find((result) => !result.ok) ?? done.results.at(-1);
			return entry({ ...(last as Result), output: joinOutputs(done.results), usage: done.usage }, done.results);
		}

		case "loop": {
			const until = step.until;
			const done = await loop({
				...common,
				steps: cast.agents,
				input: text,
				maxIterations: step.maxIterations,
				until: until === undefined ? undefined : (result) => result.output.includes(until),
			});
			// Not converging is not a model error, but it is not a success either:
			// letting the next step build on work that never reached its bar is
			// exactly the silent failure `converged` exists to expose.
			if (done.ok && until !== undefined && !done.converged) {
				return entry({ ...done, ok: false, error: `never converged on "${until}" in ${done.iterations} iteration(s)` }, done.steps);
			}
			return entry(done, done.steps);
		}

		case "reduce": {
			const results = previous?.results ?? [];
			if (results.length === 0) {
				return entry(
					failed(
						(cast.agents[0] as Agent).name,
						`reduce step "${step.id}" has nothing to fold: the previous step produced a single result`,
					),
				);
			}
			// **Not** `text`: `reduce` formats the branches itself, from `results`.
			// Handing it the previous output as well printed every report twice,
			// and a real run duly reported "duplicate reports, verbatim".
			const done = await reduce({
				...common,
				agent: cast.agents[0] as Agent,
				results,
				input: stepInput(step.prompt, request),
			});
			return entry(done, done.steps);
		}

		case "route": {
			const done = await route({
				...common,
				router: cast.agents[0] as Agent,
				destinations: cast.destinations as Agent[],
				fallback: cast.fallback,
				input: text,
			});
			return entry(done, done.steps);
		}

		case "orchestrate": {
			const done = await orchestrate({
				...common,
				planner: cast.agents[0] as Agent,
				workers: cast.workers as Agent[],
				input: text,
				maxTasks: step.maxTasks,
				concurrency: step.concurrency,
			});
			const result: Result = done.answer ?? {
				agent: (cast.agents[0] as Agent).name,
				output: done.ok ? joinOutputs(done.results) : "",
				messages: done.planning.messages,
				usage: done.usage,
				ok: done.ok,
				error: done.error,
			};
			return entry({ ...result, usage: done.usage }, done.results);
		}

		case "pair": {
			const done = await pair({
				...common,
				worker: cast.agents[0] as Agent,
				reviewer: cast.agents[1] as Agent,
				input: text,
				maxRounds: step.maxRounds,
			});
			return entry(done, done.steps);
		}

		case "deliver": {
			const done = await deliver({
				...common,
				planner: cast.agents[0] as Agent,
				workers: cast.workers as Agent[],
				reviewer: cast.reviewer as Agent,
				auditor: cast.auditor,
				brief: text,
				verify,
				maxTasks: step.maxTasks,
				concurrency: step.concurrency,
				maxRounds: step.maxRounds,
				maxAuditRounds: step.maxAuditRounds,
				resume: delivery?.resume?.(step.id),
				onProgress: delivery?.onProgress && ((progress) => delivery.onProgress?.(step.id, progress)),
			});
			const results = done.tasks.map((task) => task as Result);
			const result: Result = {
				agent: (cast.agents[0] as Agent).name,
				output: joinOutputs(results),
				messages: done.planning.messages,
				usage: done.usage,
				// An unapproved delivery is not a failed one: `deliver` already
				// separates "every turn ran" from "the work passed the bar", and
				// flattening the two here would throw away the distinction.
				ok: done.ok,
				error: done.error,
			};
			return entry(result, results, done);
		}
	}
}

/** Every output, one after the other, labelled by the agent that produced it. */
function joinOutputs(results: readonly Result[]): string {
	return results.map((result) => `## ${result.agent}\n\n${result.output}`).join("\n\n");
}

function report(onStep: ((step: PipelineStepResult) => void) | undefined, step: PipelineStepResult): void {
	if (!onStep) return;
	try {
		onStep(step);
	} catch {
		// a reporting hook is an observer: its failure is never the run's
	}
}
