/**
 * Whole results for a command's doubles.
 *
 * A command reads a corner of what a workflow returns, and a test handing it
 * only that corner had to cast the rest away - forty-eight times in two files.
 * Built whole here, from the few fields a test cares about, a double is what
 * the real thing is and the compiler keeps it so.
 */

import { succeeded } from "../../src/result.ts";
import { emptyUsage, type Usage } from "../../src/usage.ts";
import type { DeliverResult } from "../../src/workflows/deliver.ts";
import type { InterviewResult } from "../../src/workflows/interview.ts";
import type { PipelineRunResult } from "../../src/workflows/pipeline-run.ts";

/** An interview that wrote its brief, unless told otherwise. */
export function interviewResult(over: Partial<InterviewResult> = {}): InterviewResult {
	const brief = over.brief ?? "THE BRIEF";
	return { ...succeeded("interviewer", brief), brief, answers: [], steps: [], submitted: false, ...over };
}

/** A delivery that was approved, with nothing planned and nothing done, unless told otherwise. */
export function deliverResult(over: Partial<DeliverResult> = {}): DeliverResult {
	const planning = succeeded("planner", "");
	return {
		...planning,
		brief: "THE BRIEF",
		plan: [],
		planning,
		tasks: [],
		audits: [],
		obligations: [],
		landings: [],
		approved: true,
		steps: [planning],
		...over,
	};
}

/** A pipeline run that went well and said nothing, unless told otherwise. `usage` may be partial. */
export function pipelineRunResult(over: Partial<Omit<PipelineRunResult, "usage">> & { usage?: Partial<Usage> } = {}): PipelineRunResult {
	const { usage, ...rest } = over;
	return { pipeline: "explore", steps: [], output: "", usage: { ...emptyUsage(), ...usage }, ok: true, ...rest };
}
