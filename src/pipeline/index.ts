/**
 * A pipeline: a workflow written down, found by name, and run by our code.
 *
 * Three files in the order they are used - `pipeline.ts` reads the file,
 * `load.ts` finds it among the three directories a name may live in, and
 * `run.ts` walks its steps - and this is their door. What runs a pipeline is
 * not a combinator: it calls every one of them and composes with none, which
 * is why it lives here and not under `workflows/`.
 */

export { findPipeline, loadPipelines, lookupPipeline, type BrokenPipeline, type PipelineCatalogue } from "./load.ts";
export { parsePipeline, type Pipeline, type PipelineStep, type StepKind } from "./pipeline.ts";
export {
	checkPipelineAgents,
	runPipeline,
	stepInput,
	type PipelineRunOptions,
	type PipelineRunResult,
	type PipelineStepResult,
} from "./run.ts";
