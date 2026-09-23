/**
 * `runFlow`: a checked run walked from its first node to its last.
 *
 * It takes a `CheckedRun` and nothing else of the world: the working tree,
 * the ports and each check script's content were fixed by `checkRun`, so a
 * flow checked against one project cannot run in another. The runner reaches
 * git through the `git` port only, and the disk through its run directory
 * only, when it is given one.
 */

import { busFor, type EventListener } from "../../events.ts";
import type { GitPort } from "../../git/index.ts";
import { spawn as defaultSpawn } from "../../subagent.ts";
import { sumUsage, type Usage } from "../../usage.ts";
import type { CheckScript } from "../../verify.ts";
import type { SpawnFn } from "../../workflows/options.ts";
import type { CheckedRun } from "../check-run.ts";
import type { CheckedFlow, FlowError } from "../checked.ts";
import { mismatch } from "../type.ts";
import { personAsks } from "./card.ts";
import { committer } from "./commit.ts";
import { walkWhole } from "./call.ts";
import { fileJournal, NO_JOURNAL } from "./journal.ts";
import { whileLocked } from "./lock.ts";
import type { Replay } from "./replay.ts";
import { writeSnapshot } from "./snapshot.ts";
import { Transcripts } from "./transcripts.ts";
import { Run } from "./walk.ts";
import type { World } from "./world.ts";

/** What a run varies. Each defaults to the real thing. */
export type RunFlowOptions = {
	/** Defaults to the real `spawn`. Pass a `stopSwitch`'s, with its `signal`, to stop a visit or the run. */
	spawn?: SpawnFn;
	/** Aborting it stops the run: no node starts, and nothing catches the failure. Declining a card that offers no "enough" does the same. */
	signal?: AbortSignal;
	/** The run's events, its visits and its subagents' alike. */
	onEvent?: EventListener;
	/** The model of every agent turn, over the flow's `model:` and each agent's own. */
	model?: string;
	/** The bound of every agent turn, over each node's `timeout:` and the flow's. A check keeps its own. */
	timeoutMs?: number;
	/**
	 * The run directory, which holds the snapshot, the journal and each
	 * subagent's transcript, and where a `measuredRun` leaves `usage.json`.
	 * Absent, nothing touches the disk, and the run cannot be resumed.
	 */
	runDir?: string;
};

/**
 * How a run ended. `output` is the last root node's; a failure names the
 * visit it started at. `usage` sums every visit, `wallMs` being the run's.
 */
export type FlowResult =
	| { readonly ok: true; readonly output?: unknown; readonly usage: Usage }
	| { readonly ok: false; readonly error: FlowError; readonly path: string; readonly usage: Usage };

/**
 * Runs `run` on `input`. Given `runDir`, the run directory first receives
 * the snapshot, then the journal as the run goes, and the run holds its lock
 * until it ends.
 *
 * Throws, before anything is spawned, on an input off the flow's `input:`,
 * and on a run directory that already holds a run: that is the caller's
 * mistake, not a run that went wrong. Every other failure is a result.
 */
export async function runFlow(run: CheckedRun, input: unknown, options: RunFlowOptions = {}): Promise<FlowResult> {
	checkInput(run.flow, input);
	const { runDir, model, timeoutMs } = options;
	if (runDir === undefined) return walkFlow(run.flow, input, options, realWorld(run, input), run.cwd);
	writeSnapshot(runDir, run, input, { model, timeoutMs });
	return whileLocked(
		runDir,
		(why) => {
			throw new Error(why);
		},
		() => walkFlow(run.flow, input, options, realWorld(run, input, runDir), run.cwd),
	);
}

/**
 * The world of a real run: `run`'s ports, in its tree, writing its journal
 * and its transcripts to `runDir` when it has one; on a resume, with what
 * `replay` kept, the run's branch included.
 */
export function realWorld(run: CheckedRun, input: unknown, runDir?: string, replay?: Replay): World {
	const { cwd, ports, scripts } = run;
	const journal = runDir === undefined ? NO_JOURNAL : fileJournal(runDir);
	// `checkRun` refused a flow needing a port it was not given, or a script it could not read.
	const check = ports.check as CheckScript;
	const git = ports.git as GitPort;
	const commit = committer(git, cwd, input, journal, replay?.branch);
	return {
		deadline: ({ ms }) => AbortSignal.timeout(ms),
		check: (node, _path, signal, tree = cwd) => check({ script: node.script, content: scripts.get(node.script) as string, cwd: tree, timeoutMs: node.timeoutMs, signal }),
		commit: (_node, _path, message) => commit(message),
		diff: (tree = cwd) => git.diff(tree),
		copies: ports.git,
		ask: personAsks(run.somebodyThere ? ports.ask : undefined),
		journal,
		...(runDir !== undefined && { transcripts: new Transcripts(runDir) }),
		replay,
	};
}

/** Throws on an input off `flow`'s `input:`: the caller's mistake, found before anything runs. */
export function checkInput(flow: CheckedFlow, input: unknown): void {
	const problem = mismatch(input, flow.input);
	if (problem !== undefined) throw new Error(`The input of \`${flow.name}\` does not match its \`input:\`: ${problem}`);
}

/**
 * `runFlow`, with the world given and the input checked: the dry run's door
 * into the same walk, with no tree. How it ended is the journal's last entry.
 */
export async function walkFlow(checked: CheckedFlow, input: unknown, options: RunFlowOptions, world: World, tree?: string): Promise<FlowResult> {
	const started = performance.now();
	const stopped = new AbortController();
	const signal = options.signal === undefined ? stopped.signal : AbortSignal.any([options.signal, stopped.signal]);
	const stop = () => stopped.abort();
	// Before anything else, so a life killed at once is still a life of the journal.
	world.journal.append({ type: "life_start", startedAt: new Date().toISOString() });
	const run = new Run({ ...world, flow: checked, bus: busFor(options), signal, stop, spawn: options.spawn ?? defaultSpawn, model: options.model, timeoutMs: options.timeoutMs });
	const walked = await walkWhole(run, checked, "", input, { cut: signal, tree });
	const usage = sumUsage(walked.usage, performance.now() - started);
	const result: FlowResult =
		walked.failed !== undefined ? { ok: false, error: walked.failed.error, path: walked.failed.path, usage } : { ok: true, ...(walked.last?.ok && { output: walked.last.output }), usage };
	world.journal.append({ type: "run_end", ...result });
	return result;
}
