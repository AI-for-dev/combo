/**
 * `/step`, `/chain` and `/quote`: walking a chain by hand.
 *
 * `/run` runs a pipeline end to end and leaves its answer in the conversation,
 * which is right for an exploration - it is read, and then asked about. It is
 * wrong for the other use: `explorer → planner → coder → reviewer`, advanced
 * one step at a time, where the main window is a console and not an
 * interlocutor. Everything it reads it acts on, so a report landing there turns
 * it into an orchestrator nobody asked for.
 *
 * So these three do the opposite of `/run` on exactly one point. A step is
 * **drawn and not sent**: `appendEntry` renders it in the transcript and keeps
 * it out of the model's context, the output waits in the relay for the next
 * step, and `/quote` is the one door into the conversation - taken on purpose,
 * when there is something to discuss.
 *
 * What a step *is* is deliberately wide: a pipeline is a fine stage of a
 * hand-walked chain (`explore` is a fan-out and a synthesis), and so is a lone
 * agent. One command takes both, resolved in that order.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { checkModel, checkPipelineAgents, createRunDir, exportBaseName, plural } from "../src/index.ts";
import { loadRoster, parseLeadingFlags, refuse, type CommandCtx } from "./build.ts";
import { PIPELINE_MESSAGE, type PipelineDeps } from "./pipeline-commands.ts";
import {
	chainInput,
	chainLines,
	currentChain,
	forgetChain,
	recordStep,
	startChain,
	stepAnswer,
	stepFrom,
	stepId,
	type RelayStep,
} from "./relay.ts";
import { liveRun, STATUS } from "./run-ui.ts";
import { resolveTarget, runStage, type Done, type Target } from "./stage.ts";

/** `customType` of the transcript entry a finished step leaves behind. */
export const STEP_ENTRY = "chain-step";

/** What {@link STEP_ENTRY} carries, and the renderer in `index.ts` draws. */
export type StepEntry = {
	/** The step's id in the chain, which is also what `--from` takes. */
	id: string;
	/** Which of the two ran it. */
	kind: "agent" | "pipeline";
	/** The step whose output it was handed, when it was handed one. */
	from?: string;
	/** What it produced, in full - this is a transcript entry, not a summary. */
	output: string;
	/** Turns, so the entry says what it cost without expanding anything. */
	turns: number;
	/** Where this step's transcripts landed. */
	dir: string;
};

/** How a finished step reaches the transcript. Injected, so a test can catch it. */
export type AppendEntry = (customType: string, data: StepEntry) => void;

/** {@link PipelineDeps}, plus the one door `/step` uses that `/run` does not. */
export type StepDeps = PipelineDeps & { appendEntry?: AppendEntry };

/** Registers `/step`, `/chain` and `/quote`. */
export default function registerStepCommands(pi: ExtensionAPI) {
	const deps: StepDeps = {
		sendMessage: (message) => pi.sendMessage(message),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	};

	pi.registerCommand("step", {
		description:
			"Run one agent or pipeline on the previous step's output, without telling this session (`--from <id|last|none>`, `--model <pattern>`, `--agent`, `--worktree`)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runStep(args, ctx as unknown as CommandCtx, deps);
		},
	});

	pi.registerCommand("chain", {
		description: "List the steps walked so far, or `reset` to start a new chain",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			showChain(args, ctx as unknown as CommandCtx);
		},
	});

	// `quote` and not `share`: pi has a built-in `/share`, and an extension
	// command of that name is shadowed in its own autocomplete. It is also the
	// better word for what it does.
	pi.registerCommand("quote", {
		description: "Quote one step of the chain into this conversation (default: the last)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			quoteStep(args, ctx as unknown as CommandCtx, deps);
		},
	});
}

/**
 * `/step [--from <id>] [--model <pattern>] [--agent] [--worktree] <name> <instruction>`.
 *
 * One stage of the chain: the named agent or pipeline is handed the previous
 * step's output and whatever is typed after it, and what it answers goes into
 * the relay - not into this session's context.
 *
 * A failing step leaves the chain untouched. It produced no material to carry,
 * and recording it would hand the next agent an error message as its input; the
 * export is still on disk, and the same command can be retried on another
 * model.
 */
export async function runStep(args: string, ctx: CommandCtx, deps: StepDeps = {}): Promise<RelayStep | undefined> {
	const { flags, rest } = parseLeadingFlags(args, ["from", "model"], ["agent", "worktree"]);
	const [name, ...words] = rest.split(/\s+/).filter(Boolean);
	if (!name) {
		return refuse(ctx, "step: say which agent or pipeline, for example /step planner three steps at most. /agents and /pipelines list them", "warning");
	}
	const instruction = words.join(" ");

	const agents = loadRoster(ctx, deps);
	let target: Target;
	let previous: RelayStep | undefined;
	try {
		previous = stepFrom(currentChain(), flags.from);
		// A step with neither an instruction nor anything carried in asks an
		// agent to answer about nothing, which costs real tokens to discover.
		// With an output in hand it is the ordinary case: "review that".
		if (!instruction.trim() && !previous) {
			throw new Error(`step: say what ${name} should do, for example /step ${name} find where usage is measured`);
		}
		target = resolveTarget(name, flags.agent === "true", ctx, deps, agents);
		if (target.kind === "pipeline") checkPipelineAgents(target.pipeline, agents);
		if (flags.model) await (deps.checkModel ?? checkModel)(flags.model);
	} catch (cause) {
		return refuse(ctx, cause instanceof Error ? cause.message : String(cause), "error");
	}

	if (flags.worktree === "true" && target.kind === "agent") {
		ctx.ui.notify("step: --worktree gives a delivery's workers a copy of the repository - a lone agent gets none", "warning");
	}

	// One chain, one folder, one step per subfolder: a chain walked by hand is
	// still a run, and it leaves the same trace as one walked by `/run`.
	const relay = currentChain() ?? startChain((deps.runDir ?? createRunDir)());
	const id = stepId(relay, name);
	const dir = path.join(relay.dir, `${relay.steps.length + 1}-${exportBaseName(id)}`);
	const input = chainInput(instruction, previous);

	const live = liveRun(ctx.ui, { tickMs: deps.tickMs, signal: ctx.signal });
	ctx.ui.setStatus(STATUS, `running ${id}…`);

	const startedAt = performance.now();
	let done: Done;
	try {
		done = await runStage(target, input, {
			agents,
			ctx,
			deps,
			dir,
			model: flags.model,
			worktree: flags.worktree === "true",
			onEvent: live.onEvent,
			signal: live.signal,
			spawn: live.spawn,
		});
	} finally {
		live.stop(dir, performance.now() - startedAt);
	}

	if (done.error !== undefined) {
		refuse(ctx, `step: ${id} failed: ${done.error} - the chain is unchanged, what ran is in ${dir}`, "error");
		return undefined;
	}

	const { output, usage } = done;
	const step = recordStep(relay, { name, kind: target.kind, instruction, from: previous?.id, output, usage, dir });
	deps.appendEntry?.(STEP_ENTRY, { id: step.id, kind: step.kind, from: step.from, output: step.output, turns: usage.turns, dir });
	ctx.ui.notify(`${step.id}: ${plural(usage.turns, "turn")} - /step <next> carries it on, /quote puts it in this conversation`, "info");
	return step;
}

/** `/chain` - the steps walked so far. `/chain reset` starts a new one. */
export function showChain(args: string, ctx: CommandCtx): string[] {
	const word = args.trim().toLowerCase();
	if (word === "reset") {
		forgetChain();
		const lines = ["chain: dropped. The next /step starts a new one, in a new folder."];
		ctx.ui.notify(lines.join("\n"), "info");
		return lines;
	}
	if (word) {
		const lines = [`chain: say nothing to list the steps, or reset to start a new chain`];
		ctx.ui.notify(lines.join("\n"), "warning");
		return lines;
	}

	const lines = chainLines(currentChain());
	ctx.ui.notify(lines.join("\n"), "info");
	return lines;
}

/**
 * `/quote [id]` - one step of the chain, into this conversation.
 *
 * The only door out of the relay, and it stays manual: the whole reason a step
 * is drawn rather than sent is that this session acts on whatever it reads.
 */
export function quoteStep(args: string, ctx: CommandCtx, deps: StepDeps = {}): RelayStep | undefined {
	const relay = currentChain();
	let step: RelayStep | undefined;
	try {
		step = stepFrom(relay, args.trim() || "last");
	} catch (cause) {
		return refuse(ctx, cause instanceof Error ? cause.message : String(cause), "error");
	}
	if (!step || !relay) return refuse(ctx, "quote: nothing has run yet - /step <agent|pipeline> <task> starts a chain", "warning");

	deps.sendMessage?.({
		customType: PIPELINE_MESSAGE,
		content: stepAnswer(step),
		display: true,
		// The header names the **chain**, not the step: the first line of the
		// quote already says which step it is, and `scout · scout → planner` read
		// as a repetition rather than as a position in a chain.
		details: { pipeline: "chain", steps: relay.steps.map((one) => one.id), exportDir: step.dir },
	});
	ctx.ui.notify(`quote: ${step.id} is now in this conversation`, "info");
	return step;
}
