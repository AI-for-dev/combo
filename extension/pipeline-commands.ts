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

import { checkPipelineAgents, plural, type PipelineCatalogue, type PipelineRunResult } from "../src/index.ts";
import { checked, choosePipeline, loadCatalogue, loadRoster, pipelineVerifier, refuse, watched } from "./command.ts";
import { sessionDoors, type CommandCtx, type PiApi } from "./pi.ts";
import { resolved, type CommandDeps, type PipelineDeps, type SendMessage } from "./deps.ts";
import { parseLeadingFlags, switchValue } from "./flags.ts";
import { framed } from "./relay.ts";

/**
 * `customType` of the message a finished pipeline leaves in the session.
 *
 * A custom message rather than a user one - see {@link SendMessage} for the
 * three doors pi offers and why this is the only one that fits. pi converts it
 * to the **user** role on the way to the model (`convertToLlm`,
 * `role: "custom"` → `role: "user"`), so the content carries a header naming
 * the pipeline: read as something the user typed, an unattributed report is
 * confusing; read as a quoted result, it is exactly right.
 */
export const PIPELINE_MESSAGE = "pipeline-result";

/** Registers `/pipelines` and `/run`. */
export default function registerPipelineCommands(pi: PiApi) {
	const doors = sessionDoors(pi);

	pi.registerCommand("pipelines", {
		description: "List the pipelines that are loaded, and where they come from",
		handler: async (_args, ctx: CommandCtx) => {
			listPipelines(ctx);
		},
	});

	pi.registerCommand("run", {
		description: "Run a pipeline by name, with no interview and no commit (`--model <pattern>`, `--worktree`)",
		handler: async (args, ctx: CommandCtx) => {
			await runNamed(args, ctx, doors);
		},
	});
}

/**
 * One line per pipeline: its name, where it came from, what it is for.
 *
 * Formatting is kept away from the terminal so it can be asserted on directly -
 * the same split as the run picture. The broken files are listed **with the
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
export function listPipelines(ctx: CommandCtx, deps: CommandDeps = {}): string[] {
	const catalogue = loadCatalogue(ctx, resolved(deps));
	const lines = pipelineLines(catalogue, ctx.cwd);
	ctx.ui.notify(lines.join("\n"), catalogue.broken.length > 0 ? "warning" : "info");
	return lines;
}

/**
 * `/run [--model <pattern>] [--worktree] <pipeline> <what it should work on>`.
 *
 * No interview and no commit stop: this runs a pipeline and hands back what it
 * said. Whatever a step writes to the working tree is still written - `/run` is
 * lighter than `/build`, not safer - so the pipeline's own agents decide that,
 * as they always did.
 *
 * The answer lands **in the conversation** ({@link PIPELINE_MESSAGE}), not in
 * the prompt editor. An exploration is read, and then asked about; putting it
 * where the user types means they have to send their own report back to the
 * model before it knows anything about it.
 */
export async function runNamed(args: string, ctx: CommandCtx, injected: PipelineDeps): Promise<PipelineRunResult | undefined> {
	const deps = resolved(injected);
	const { flags, rest: text } = parseLeadingFlags(args, ["model"], ["worktree"]);
	const model = flags.model;
	const worktree = switchValue(flags, "worktree");
	const [name, ...rest] = text.split(/\s+/).filter(Boolean);
	if (!name) {
		return refuse(ctx, "run: say which pipeline, for example /run explore how usage is measured. /pipelines lists them", "warning");
	}
	const input = rest.join(" ");
	if (!input.trim()) {
		// A pipeline with nothing to work on spawns agents that read a blank
		// request and answer about nothing, which costs real tokens to discover.
		return refuse(ctx, `run: say what ${name} should work on, for example /run ${name} how usage is measured`, "warning");
	}

	const agents = loadRoster(ctx, deps);
	const pipeline = await checked(ctx, async () => {
		// The same chooser `/build` uses, so a broken file is named here too
		// rather than reported as an unknown pipeline.
		const chosen = choosePipeline(name, ctx, deps);
		checkPipelineAgents(chosen, agents);
		if (model) await deps.checkModel(model);
		return chosen;
	});
	if (!pipeline) return undefined;

	const exportDir = deps.runDir();
	const done = await watched(ctx, deps, {
		status: `running ${pipeline.name}…`,
		dir: exportDir,
		work: (live) =>
			deps.runPipeline({
				pipeline,
				agents,
				input,
				cwd: ctx.cwd,
				exportDir,
				verify: deps.verify ?? pipelineVerifier(pipeline, ctx.cwd),
				model,
				worktree,
				signal: live.signal,
				spawn: live.spawn,
				onEvent: live.onEvent,
			}),
	});

	if (!done.ok) {
		refuse(ctx, `run: ${done.error ?? "unknown error"} - what ran is in ${exportDir}`, "error");
		return done;
	}

	injected.sendMessage({
		customType: PIPELINE_MESSAGE,
		content: pipelineAnswer(pipeline.name, input, done.output),
		display: true,
		details: { pipeline: pipeline.name, steps: done.steps.map((step) => step.id), exportDir },
	});
	ctx.ui.notify(
		`${pipeline.name}: ${plural(done.steps.length, "step")}, ${plural(done.usage.turns, "turn")} - exported to ${exportDir}`,
		"info",
	);
	return done;
}

/** The answer, framed so a user-role slot does not misread it - the relay's framing, for a pipeline. */
export function pipelineAnswer(name: string, input: string, output: string): string {
	return framed(`the \`${name}\` pipeline`, input, output);
}
