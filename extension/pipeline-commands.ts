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

/**
 * `customType` of the message a finished pipeline leaves in the session.
 *
 * A **custom** message, and not for want of trying: pi's extension API offers
 * exactly three doors into a conversation - `sendMessage` (custom, in the
 * model's context), `sendUserMessage` (a user message, and it always triggers a
 * turn) and `appendEntry` (drawn, but invisible to the model). There is no
 * assistant-message injection. A custom message is the only one that lands the
 * answer in context without launching a turn nobody asked for.
 *
 * pi converts it to the **user** role on the way to the model
 * (`convertToLlm`, `role: "custom"` → `role: "user"`), so the content carries a
 * header naming the pipeline: read as something the user typed, an unattributed
 * report is confusing; read as a quoted result, it is exactly right.
 */
export const PIPELINE_MESSAGE = "pipeline-result";

/** How a finished run reaches the conversation. Injected, so a test can catch it. */
export type SendMessage = (message: {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}) => void;

/** {@link BuildDeps}, plus the one thing only these commands do. */
export type PipelineDeps = BuildDeps & { sendMessage?: SendMessage };

/** Registers `/pipelines` and `/run`. */
export default function registerPipelineCommands(pi: ExtensionAPI) {
	const sendMessage: SendMessage = (message) => pi.sendMessage(message);

	pi.registerCommand("pipelines", {
		description: "List the pipelines that are loaded, and where they come from",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			listPipelines(ctx as unknown as CommandCtx);
		},
	});

	pi.registerCommand("run", {
		description: "Run a pipeline by name, with no interview and no commit",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runNamed(args, ctx as unknown as CommandCtx, { sendMessage });
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
export function listPipelines(ctx: CommandCtx, deps: PipelineDeps = {}): string[] {
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
 * The answer lands **in the conversation** ({@link PIPELINE_MESSAGE}), not in
 * the prompt editor. An exploration is read, and then asked about; putting it
 * where the user types means they have to send their own report back to the
 * model before it knows anything about it.
 */
export async function runNamed(args: string, ctx: CommandCtx, deps: PipelineDeps = {}): Promise<PipelineRunResult | undefined> {
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

	deps.sendMessage?.({
		customType: PIPELINE_MESSAGE,
		content: pipelineAnswer(pipeline.name, rest.join(" "), done.output),
		display: true,
		details: { pipeline: pipeline.name, steps: done.steps.map((step) => step.id), exportDir },
	});
	ctx.ui.notify(
		`${pipeline.name}: ${done.steps.length} step(s), ${done.usage.turns} turns - exported to ${exportDir}`,
		"info",
	);
	return done;
}

/**
 * The answer, framed so a user-role slot does not misread it.
 *
 * pi hands custom messages to the model as user messages, and an unattributed
 * report arriving in that slot reads as an instruction. Two lines of framing
 * turn it back into what it is: the result of something that was run.
 */
export function pipelineAnswer(name: string, input: string, output: string): string {
	const asked = input.trim() ? `, asked to: ${input.trim()}` : "";
	return `Result of the \`${name}\` pipeline${asked}.\n\n${output.trim()}`;
}
