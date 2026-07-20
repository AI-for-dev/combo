/**
 * `/pipelines` and `/run`: seeing what there is, and running it.
 *
 * `/build` delivers a change, and it is built around that: an interview to
 * settle what "done" means, and a commit at the end. A pipeline that only
 * *reads* - three scouts and a synthesis - goes through neither, and putting it
 * through `/build` means being interviewed about a request that wants no
 * decision and then being told there is nothing to commit. So `/run` exists:
 * the pipeline, its answer, and nothing around it.
 *
 * `/pipelines` exists because of a real failure, not a hunch: a pipeline of one
 * repository was invisible from another, the error said where pipelines live but
 * not what had actually been loaded, and there was no way to ask. A list is one
 * command and it answers that in a second.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	checkPipelineAgents,
	createRunDir,
	findPipeline,
	loadAgents,
	loadPipelines,
	runPipeline,
	type Pipeline,
	type PipelineCatalogue,
	type PipelineRunResult,
} from "../src/index.ts";
import type { BuildDeps, CommandCtx } from "./build.ts";
import { liveRun, pipelineVerifier, STATUS } from "./run-ui.ts";

/** Registers `/pipelines` and `/run`. */
export default function registerPipelineCommands(pi: ExtensionAPI) {
	pi.registerCommand("pipelines", {
		description: "List the pipelines that are loaded, and where they come from",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			listPipelines(ctx as unknown as CommandCtx);
		},
	});

	pi.registerCommand("run", {
		description: "Run a pipeline by name, with no interview and no commit",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runNamed(args, ctx as unknown as CommandCtx);
		},
	});
}

/**
 * One line per pipeline: its name, where it came from, what it is for.
 *
 * Formatting is kept away from the terminal so it can be asserted on directly -
 * the same split as the TUI collector. The broken files are listed **with the
 * good ones**: a file that does not parse is the single most likely reason
 * somebody is running this command at all.
 */
export function pipelineLines(catalogue: PipelineCatalogue, cwd: string): string[] {
	if (catalogue.pipelines.length === 0 && catalogue.broken.length === 0) {
		return [
			"No pipelines loaded.",
			`Put one in ${cwd}/.pi/pipelines/ for this repository, or in ~/.pi/agent/pipelines/ for every project.`,
			"With none, /build runs its built-in default.",
		];
	}

	const width = Math.max(...catalogue.pipelines.map((one) => one.name.length), 0);
	const lines = catalogue.pipelines.map((one) => {
		const steps = one.steps.map((step) => step.kind).join(" → ");
		return `${one.name.padEnd(width)}  ${steps}${one.description ? ` - ${one.description}` : ""}`;
	});

	for (const one of catalogue.broken) {
		lines.push(`${one.name.padEnd(width)}  BROKEN: ${one.error} (${one.filePath})`);
	}
	return lines;
}

/** `/pipelines` - what is loaded, from where, and what does not parse. */
export function listPipelines(ctx: CommandCtx, deps: BuildDeps = {}): string[] {
	const catalogue = (deps.loadPipelines ?? loadPipelines)({ cwd: ctx.cwd, scope: "both", builtin: true });
	const lines = pipelineLines(catalogue, ctx.cwd);
	ctx.ui.notify(lines.join("\n"), catalogue.broken.length > 0 ? "warning" : "info");
	return lines;
}

/**
 * `/run <pipeline> <what it should work on>`.
 *
 * No interview and no commit stop: this runs a pipeline and hands back what it
 * said. Whatever a step writes to the working tree is still written - `/run` is
 * lighter than `/build`, not safer - so the pipeline's own agents decide that,
 * as they always did.
 *
 * The answer goes into the prompt editor rather than a notification: it is
 * usually long, and sending it on to the model stays the user's decision.
 */
export async function runNamed(args: string, ctx: CommandCtx, deps: BuildDeps = {}): Promise<PipelineRunResult | undefined> {
	const [name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
	if (!name) {
		ctx.ui.notify("run: say which pipeline, for example /run explore how usage is measured. /pipelines lists them", "warning");
		return undefined;
	}

	const agents = (deps.loadAgents ?? loadAgents)({ cwd: ctx.cwd, scope: "both", builtin: true });
	let pipeline: Pipeline;
	try {
		pipeline = findPipeline((deps.loadPipelines ?? loadPipelines)({ cwd: ctx.cwd, scope: "both", builtin: true }), name);
		// Before anything is spawned, as everywhere: a typo costs a second.
		checkPipelineAgents(pipeline, agents);
	} catch (cause) {
		ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
		return undefined;
	}

	const exportDir = (deps.runDir ?? createRunDir)();
	const live = liveRun(ctx.ui, deps.tickMs ?? 250);
	ctx.ui.setStatus(STATUS, `running ${pipeline.name}…`);

	let done: PipelineRunResult | undefined;
	try {
		done = await (deps.runPipeline ?? runPipeline)({
			pipeline,
			agents,
			input: rest.join(" "),
			cwd: ctx.cwd,
			exportDir,
			verify: deps.verify ?? pipelineVerifier(pipeline, ctx.cwd),
			signal: ctx.signal,
			onEvent: live.onEvent,
		});
	} finally {
		live.stop(exportDir, done?.usage.wallMs ?? 0);
	}

	if (!done.ok) {
		ctx.ui.notify(`run: ${done.error ?? "unknown error"} - what ran is in ${exportDir}`, "error");
		return done;
	}

	ctx.ui.setEditorText(done.output);
	ctx.ui.notify(
		`${pipeline.name}: ${done.steps.length} step(s), ${done.usage.turns} turns - exported to ${exportDir}`,
		"info",
	);
	return done;
}
