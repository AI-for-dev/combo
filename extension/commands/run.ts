/**
 * `/run <flow> <input>`: a flow run by name, in a run directory of its own,
 * its answer left in the conversation; `/run resume [path]` carries one on.
 *
 * What describes the work is in the flow's file: its questions, its checks,
 * its copies, its commit. What belongs to whoever types the command is on the
 * line, and only that: the model they hold keys for (`--model`) and how long
 * one turn may take (`--timeout`). Every run gets `runs/<timestamp>/`, so any
 * run can be resumed, and is measured there.
 *
 * Both stages of validation run before the first spawn, the run stage with
 * this terminal's ports: its question card when somebody is here, the
 * project's scripts, and git. A flow that needs a repository is refused
 * outside one by that stage, which names the node needing it.
 */

import * as path from "node:path";
import {
	bashCheck,
	checkFlow,
	checkRun,
	gitPort,
	latestResumable,
	parseDuration,
	readJournal,
	readSnapshot,
	resumeFlow,
	resumePoint,
	runFlow,
	type CheckedFlow,
	type Fault,
	type FlowPorts,
	type FlowResult,
	type JournalEntry,
	type RunFlowOptions,
} from "../../src/index.ts";
import { checked, loadFlows, refuse, watched } from "../command.ts";
import { resolved, type Deps, type MessageDeps } from "../deps.ts";
import { parseFlags } from "../flags.ts";
import { sessionDoors, type CommandCtx, type PiApi } from "../pi.ts";
import { createAskUi } from "../ui/index.ts";
import { answer, shown } from "./answer.ts";
import { faultRows, notified, showFlows } from "./flows.ts";

/** What `/run` is given on the line besides the flow and its input. */
type Settings = { readonly model?: string; readonly timeoutMs?: number };

/** Registers `/run`. */
export default function registerRunCommand(pi: PiApi) {
	const doors = sessionDoors(pi);
	pi.registerCommand("run", {
		description: "Run a flow on an input and put its answer in the conversation (`--model <pattern>`, `--timeout 10m`), or `resume [<run directory>]` to carry one on",
		handler: async (args, ctx: CommandCtx) => {
			await runCommand(args, ctx, doors);
		},
	});
}

/**
 * `/run [--model <pattern>] [--timeout <duration>] <flow> <input>`, the two
 * flags before the flow or at the end of the line, `/run resume [<run
 * directory>]`, or `/run` alone for the list of flows.
 * Resolves to how the run ended, or `undefined` when it was refused before it
 * started.
 */
export async function runCommand(args: string, ctx: CommandCtx, injected: MessageDeps): Promise<FlowResult | undefined> {
	const deps = resolved(injected);
	const { flags, rest } = parseFlags(args, ["model", "timeout"]);
	const timeoutMs = flags.timeout === undefined ? undefined : parseDuration(flags.timeout);
	if (flags.timeout !== undefined && timeoutMs === undefined) return refuse(ctx, "run: --timeout takes a duration written 90s, 10m or 1h", "warning");
	const [, name = "", written = ""] = /^(\S*)\s*([\s\S]*)$/.exec(rest) ?? [];
	// The input is free text; one written as a single quoted string is the text inside.
	const input = /^"[^"]*"$/.test(written.trim()) ? written.trim().slice(1, -1) : written;
	if (name === "") {
		showFlows("", ctx, injected);
		return undefined;
	}
	const settings: Settings = { model: flags.model, timeoutMs };
	return name === "resume" ? resume(input.trim(), settings, ctx, deps, injected) : start(name, input.trim(), settings, ctx, deps, injected);
}

async function start(name: string, input: string, settings: Settings, ctx: CommandCtx, deps: Deps, doors: MessageDeps): Promise<FlowResult | undefined> {
	const flow = checkFlow(name, loadFlows(ctx, deps));
	if (!flow.ok) return refused(ctx, `run: \`${name}\` is refused`, flow.faults);
	if (input === "") {
		// A flow with nothing to work on spawns agents that read a blank
		// request and answer about nothing, which costs real tokens to discover.
		return refuse(ctx, `run: say what ${name} should work on, for example /run ${name} how usage is measured`, "warning");
	}
	const { model, timeoutMs } = settings;
	if (model !== undefined && !(await checked(ctx, async () => (await deps.checkModel(model), true)))) return undefined;
	const staged = await checkRun(flow.flow, { cwd: ctx.cwd, ports: portsOf(ctx), somebodyThere: ctx.hasUI });
	if (!staged.ok) return refused(ctx, `run: \`${name}\` cannot run here`, staged.faults);

	const runDir = deps.runDir();
	const result = await live(ctx, deps, flow.flow, [], runDir, `running ${name}…`, (options) => runFlow(staged.run, input, { ...options, model, timeoutMs, runDir }));
	if (result !== undefined) answer(ctx, doors, flow.flow, input, runDir, result);
	return result;
}

/**
 * Carries on the run in `where`, or the newest one here a resume would take,
 * saying which and from which visit. The input and the model are the run's
 * own; only `--timeout` may be given again.
 */
async function resume(where: string, settings: Settings, ctx: CommandCtx, deps: Deps, doors: MessageDeps): Promise<FlowResult | undefined> {
	if (settings.model !== undefined) return refuse(ctx, "run: a resume runs on the model its run started with - a new run is how to change it", "warning");
	let runDir = path.resolve(ctx.cwd, where);
	if (where === "") {
		const found = latestResumable(path.join(ctx.cwd, "runs"), ctx.cwd);
		if (found === undefined) return refuse(ctx, "run: no run here to resume - /run <flow> <input> starts one", "warning");
		if (!found.ok) return refuse(ctx, `run: nothing here to resume - the last run, ${shown(ctx, found.runDir)}, cannot be: ${found.refused}`, "warning");
		runDir = found.runDir;
	}
	const snapshot = await checked(ctx, () => readSnapshot(runDir));
	if (snapshot === undefined) return undefined;
	const flow = checkFlow(snapshot.flow, snapshot.catalogue);
	if (!flow.ok) return refused(ctx, `run: ${shown(ctx, runDir)} no longer checks`, flow.faults);
	const journal = readJournal(runDir);
	const point = resumePoint(flow.flow, journal);
	if (!point.ok) return refuse(ctx, `run: ${shown(ctx, runDir)} cannot be resumed - ${point.refused}`, "warning");
	ctx.ui.notify(`run: resuming ${snapshot.flow} in ${shown(ctx, runDir)}, from ${point.from === "" ? "its end" : point.from}`, "info");

	const resumed = await live(ctx, deps, flow.flow, journal, runDir, `resuming ${snapshot.flow}…`, (options) =>
		resumeFlow(runDir, { ...options, ports: portsOf(ctx), somebodyThere: ctx.hasUI, timeoutMs: settings.timeoutMs }),
	);
	if (resumed === undefined) return undefined;
	if ("refused" in resumed) return refuse(ctx, `run: ${shown(ctx, runDir)} cannot be resumed - ${resumed.refused}`, "error");
	if ("faults" in resumed) return refused(ctx, `run: ${shown(ctx, runDir)} cannot run here`, resumed.faults);
	if (resumed.changed !== undefined) ctx.ui.notify(`run: ${resumed.changed}`, "warning");
	answer(ctx, doors, flow.flow, snapshot.input, runDir, resumed);
	return resumed;
}

/** What a run is handed by the live view: the stop switch's `spawn` and `signal`, and the view's `onEvent`. */
type Launch = Required<Pick<RunFlowOptions, "spawn" | "signal" | "onEvent">>;

/**
 * `work` under the live view of `checked`, measured into `runDir` with the
 * parent session. A throw is a mistake of the caller the checks could not
 * see, a typed input written wrong or a directory already holding a run: it
 * is said, and nothing more.
 */
async function live<T>(ctx: CommandCtx, deps: Deps, checked: CheckedFlow, journal: readonly JournalEntry[], runDir: string, status: string, work: (launch: Launch) => Promise<T>): Promise<T | undefined> {
	try {
		return await watched(ctx, deps, {
			status,
			dir: runDir,
			live: { flow: { checked, journal }, spawn: deps.spawn, mainSessionFile: ctx.sessionManager?.getSessionFile() },
			work: ({ spawn, signal, onEvent }) => work({ spawn, signal, onEvent }),
		});
	} catch (cause) {
		return refuse(ctx, `run: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
	}
}

/**
 * How this terminal reaches the world: its question card, the project's
 * scripts through bash, and git. The card is handed over even with nobody
 * here, since `somebodyThere` is what keeps a run from showing it, and a
 * refusal then says that rather than blaming a missing port.
 */
function portsOf(ctx: CommandCtx): FlowPorts {
	return { ask: createAskUi(ctx.ui), check: bashCheck(), git: gitPort() };
}

/**
 * Says `lead`, then each fault on a line of its own, `file at: message`. A
 * name no file answers to is one fault of no file, and says it all alone.
 */
function refused(ctx: CommandCtx, lead: string, faults: readonly Fault[]): undefined {
	const [only] = faults;
	const rows = faults.length === 1 && only?.file === "" ? [{ text: `run: ${only.message}`, hang: 5 }] : [{ text: lead, hang: 5 }, ...faultRows(faults)];
	return refuse(ctx, notified(rows, ctx.cwd).join("\n"), "error");
}
