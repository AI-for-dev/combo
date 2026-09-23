/**
 * `/step`, `/chain` and `/quote`: walking a chain by hand.
 *
 * `/run` runs a flow end to end and leaves its answer in the conversation,
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
 * What a step *is* is deliberately wide: a flow is a fine stage of a
 * hand-walked chain (`explore` is a fan-out and a synthesis), and so is a lone
 * agent. One command takes both, resolved in that order.
 */

import { plural } from "../../src/index.ts";
import { checked, loadRoster, refuse } from "../command.ts";
import { sessionDoors, type CommandCtx, type PiApi } from "../pi.ts";
import { resolved, type StepDeps } from "../deps.ts";
import { parseLeadingFlags } from "../flags.ts";
import { RESULT_MESSAGE, type ResultDetails } from "./answer.ts";
import { beginStep, chainInput, chainLines, currentChain, finishStep, forgetChain, stepAnswer, stepFrom, type RelayStep } from "../relay.ts";
import { resolveTarget, runStage } from "./stage.ts";

/** Registers `/step`, `/chain` and `/quote`. */
export default function registerStepCommands(pi: PiApi) {
	const deps = sessionDoors(pi);

	pi.registerCommand("step", {
		description:
			"Run one flow or agent on the previous step's output, without telling this session (`--from <id|last|none>`, `--model <pattern>`, `--agent`)",
		handler: async (args, ctx: CommandCtx) => {
			await runStep(args, ctx, deps);
		},
	});

	pi.registerCommand("chain", {
		description: "List the steps walked so far, or `reset` to start a new chain",
		handler: async (args, ctx: CommandCtx) => {
			showChain(args, ctx);
		},
	});

	// `quote` and not `share`: pi has a built-in `/share`, and an extension
	// command of that name is shadowed in its own autocomplete. It is also the
	// better word for what it does.
	pi.registerCommand("quote", {
		description: "Quote one step of the chain into this conversation (default: the last)",
		handler: async (args, ctx: CommandCtx) => {
			quoteStep(args, ctx, deps);
		},
	});
}

/**
 * `/step [--from <id>] [--model <pattern>] [--agent] <name> <instruction>`.
 *
 * One stage of the chain: the named flow or agent is handed the previous
 * step's output and whatever is typed after it, and what it answers goes into
 * the relay - not into this session's context.
 *
 * A failing step leaves the chain untouched. It produced no material to carry,
 * and recording it would hand the next agent an error message as its input; the
 * export is still on disk, and the same command can be retried on another
 * model.
 */
export async function runStep(args: string, ctx: CommandCtx, injected: StepDeps): Promise<RelayStep | undefined> {
	const deps = resolved(injected);
	const { flags, rest } = parseLeadingFlags(args, ["from", "model"], ["agent"]);
	const [name, ...words] = rest.split(/\s+/).filter(Boolean);
	if (!name) {
		return refuse(ctx, "step: say which flow or agent, for example /step planner three steps at most. /agents lists them", "warning");
	}
	const instruction = words.join(" ");

	const agents = loadRoster(ctx, deps);
	const stage = await checked(ctx, async () => {
		const previous = stepFrom(currentChain(), flags.from);
		// A step with neither an instruction nor anything carried in asks an
		// agent to answer about nothing, which costs real tokens to discover.
		// With an output in hand it is the ordinary case: "review that".
		if (!instruction.trim() && !previous) {
			throw new Error(`step: say what ${name} should do, for example /step ${name} find where usage is measured`);
		}
		const target = await resolveTarget(name, flags.agent === "true", ctx, deps, agents);
		if (flags.model) await deps.checkModel(flags.model);
		return { target, previous };
	});
	if (!stage) return undefined;
	const { target, previous } = stage;

	const begun = beginStep(name, deps.runDir);
	const input = chainInput(instruction, previous);
	const done = await checked(ctx, () => runStage(target, input, { ctx, deps, dir: begun.dir, model: flags.model, status: `running ${begun.id}…` }));
	if (done === undefined) return undefined;
	if (done.failed !== undefined) {
		refuse(ctx, `step: ${begun.id} ${done.failed.why} - the chain is unchanged, ${done.failed.next}`, "error");
		return undefined;
	}

	const { output, usage } = done;
	const step = finishStep(begun, { name, kind: target.kind, instruction, from: previous?.id, output, usage }, injected.appendEntry);
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
export function quoteStep(args: string, ctx: CommandCtx, deps: StepDeps): RelayStep | undefined {
	const relay = currentChain();
	// `checked` is for what runs before a spawn; nothing is spawned here, but the
	// refusal has the same shape, and one shape is the point.
	let step: RelayStep | undefined;
	try {
		step = stepFrom(relay, args.trim() || "last");
	} catch (cause) {
		return refuse(ctx, cause instanceof Error ? cause.message : String(cause), "error");
	}
	if (!step || !relay) return refuse(ctx, "quote: nothing has run yet - /step <flow|agent> <task> starts a chain", "warning");

	deps.sendMessage({
		customType: RESULT_MESSAGE,
		content: stepAnswer(step),
		display: true,
		// The header names the **chain**, not the step: the first line of the
		// quote already says which step it is, and `scout · scout → planner` read
		// as a repetition rather than as a position in a chain.
		details: { name: "chain", steps: relay.steps.map((one) => one.id), runDir: step.dir } satisfies ResultDetails,
	});
	ctx.ui.notify(`quote: ${step.id} is now in this conversation`, "info");
	return step;
}
