/**
 * A flow launched from pi: checked at both stages against this terminal, then
 * run in its run directory under the live view.
 *
 * `/run`, a flow stage of `/step` and the `subagent` tool launch a flow the
 * same way: the same ports, the same answer to whether somebody is there, the
 * same plan above the prompt, the same measurement in the run directory. What
 * each does with a refusal and with the result stays in its own file.
 */

import {
	bashCheck,
	checkFlow,
	checkRun,
	gitPort,
	runFlow,
	type CheckedFlow,
	type CheckedRun,
	type Fault,
	type FlowCatalogue,
	type FlowPorts,
	type FlowResult,
	type JournalEntry,
	type MainSession,
	type RunFlowOptions,
} from "../../src/index.ts";
import { watched } from "../command.ts";
import type { CommandDeps } from "../deps.ts";
import { somebodyThere, type AskUi, type CommandCtx, type RunUi } from "../pi.ts";
import { createAskUi, type LiveRunOptions } from "../ui/index.ts";
import { faultRows, notified } from "./flows.ts";

/** What a launch reads of pi: the tree, how pi runs, the terminal when there is one, and pi's signal. */
export type LaunchCtx = { cwd: string; mode?: CommandCtx["mode"]; ui?: RunUi & AskUi; signal?: AbortSignal };

/** A flow that may run here, or the stage that refused it and every fault it found. */
export type Launchable = { ok: true; run: CheckedRun } | { ok: false; stage: "flow" | "run"; faults: readonly Fault[] };

/** The flow `name` of `catalogue`, checked whole, then held to `ctx`: its tree, its ports, and whether somebody is there. */
export async function launchable(name: string, catalogue: FlowCatalogue, ctx: LaunchCtx): Promise<Launchable> {
	const flow = checkFlow(name, catalogue);
	if (!flow.ok) return { ok: false, stage: "flow", faults: flow.faults };
	const staged = await checkRun(flow.flow, { cwd: ctx.cwd, ports: portsOf(ctx), somebodyThere: somebodyThere(ctx) });
	return staged.ok ? staged : { ok: false, stage: "run", faults: staged.faults };
}

/**
 * How this terminal reaches the world: its question card, the project's
 * scripts through bash, and git. The card is handed over even with nobody
 * here, since `somebodyThere` is what keeps a run from showing it, and a
 * refusal then says that rather than blaming a missing port.
 */
export function portsOf(ctx: Pick<LaunchCtx, "ui">): FlowPorts {
	return { ...(ctx.ui && { ask: createAskUi(ctx.ui) }), check: bashCheck(), git: gitPort() };
}

/**
 * `lead` as `who` says it, then each fault on a line of its own, `file at:
 * message`. A name no file answers to is one fault of no file, and says it
 * all alone.
 */
export function refusal(who: string, lead: string, faults: readonly Fault[], cwd: string): string {
	const [only] = faults;
	const rows = faults.length === 1 && only?.file === "" ? [{ text: `${who}: ${only.message}`, hang: who.length + 2 }] : [{ text: `${who}: ${lead}`, hang: who.length + 2 }, ...faultRows(faults)];
	return notified(rows, cwd).join("\n");
}

/** Why the flow `name` did not launch, as `who` says it. */
export function notLaunched(who: string, name: string, refused: Extract<Launchable, { ok: false }>, cwd: string): string {
	return refusal(who, `\`${name}\` ${refused.stage === "flow" ? "is refused" : "cannot run here"}`, refused.faults, cwd);
}

/** Where a launched run goes, what it runs on, and what the caller adds to its view. */
export type Launch = {
	/** Its run directory, which must hold no run yet. */
	readonly runDir: string;
	readonly model?: string;
	readonly timeoutMs?: number;
	/** The footer while it runs. */
	readonly status?: string;
	/** This session, whose JSONL lands beside the subagents'. */
	readonly mainSession?: MainSession;
	/** What else watches the run: the tool streams a progress line, a test injects a reporter. */
	readonly view?: Pick<LiveRunOptions, "reporter" | "herdrAll" | "onChange">;
};

/** Runs `run` on `input` in `at.runDir`, under the live view of its plan. Throws what `runFlow` throws. */
export function launch(ctx: LaunchCtx, deps: Pick<CommandDeps, "spawn" | "tickMs">, run: CheckedRun, input: unknown, at: Launch): Promise<FlowResult> {
	const { runDir, model, timeoutMs } = at;
	return underPlan(ctx, deps, run.flow, [], at, (options) => runFlow(run, input, { ...options, model, timeoutMs, runDir }));
}

/** What a run is handed by the live view: the stop switch's `spawn` and `signal`, and the view's `onEvent`. */
export type Launched = Required<Pick<RunFlowOptions, "spawn" | "signal" | "onEvent">>;

/**
 * `work` under the live view of `checked`, whose earlier lives wrote
 * `journal`, measured into `at.runDir` with the parent session.
 */
export function underPlan<T>(ctx: LaunchCtx, deps: Pick<CommandDeps, "spawn" | "tickMs">, checked: CheckedFlow, journal: readonly JournalEntry[], at: Omit<Launch, "model" | "timeoutMs">, work: (launched: Launched) => Promise<T>): Promise<T> {
	return watched(ctx, deps, {
		status: at.status,
		dir: at.runDir,
		live: { ...at.view, flow: { checked, journal }, spawn: deps.spawn, mainSession: at.mainSession },
		work: ({ spawn, signal, onEvent }) => work({ spawn, signal, onEvent }),
	});
}
