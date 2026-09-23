/**
 * `runFlow`: a checked run walked from its first node to its last.
 *
 * It takes a `CheckedRun` and nothing else of the world: the working tree,
 * the ports and each check script's content were fixed by `checkRun`, so a
 * flow checked against one project cannot run in another. The runner reaches
 * git through the `git` port only.
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
import { committer } from "./commit.ts";
import { Frames } from "./frames.ts";
import { Values } from "./values.ts";
import type { Walked } from "./ended.ts";
import { Run, type World } from "./walk.ts";

/** What a run varies. Each defaults to the real thing. */
export type RunFlowOptions = {
	/** Defaults to the real `spawn`. Pass a `stopSwitch`'s, with its `signal`, to stop a visit or the run. */
	spawn?: SpawnFn;
	/** Aborting it stops the run: no node starts, and nothing catches the failure. */
	signal?: AbortSignal;
	/** The run's events, its visits and its subagents' alike. */
	onEvent?: EventListener;
	/** The model of every agent turn, over the flow's `model:` and each agent's own. */
	model?: string;
	/** The bound of every agent turn, over each node's `timeout:` and the flow's. A check keeps its own. */
	timeoutMs?: number;
};

/**
 * How a run ended. `output` is the last root node's; a failure names the
 * visit it started at. `usage` sums every visit, `wallMs` being the run's.
 */
export type FlowResult =
	| { readonly ok: true; readonly output?: unknown; readonly usage: Usage }
	| { readonly ok: false; readonly error: FlowError; readonly path: string; readonly usage: Usage };

/**
 * Runs `run` on `input`.
 *
 * Throws, before anything is spawned, on an input off the flow's `input:`:
 * that is the caller's mistake, not a run that went wrong. Every other
 * failure is a result.
 */
export function runFlow(run: CheckedRun, input: unknown, options: RunFlowOptions = {}): Promise<FlowResult> {
	const { flow, cwd, ports, scripts } = run;
	// `checkRun` refused a flow needing a port it was not given, or a script it could not read.
	const check = ports.check as CheckScript;
	const git = ports.git as GitPort;
	const commit = committer(git, cwd, input);
	return walkFlow(flow, input, options, {
		deadline: ({ ms }) => AbortSignal.timeout(ms),
		check: (node, _path, signal, tree = cwd) => check({ script: node.script, content: scripts.get(node.script) as string, cwd: tree, timeoutMs: node.timeoutMs, signal }),
		commit: (_node, _path, message) => commit(message),
		diff: (tree = cwd) => git.diff(tree),
		copies: ports.git,
	}, cwd);
}

/** `runFlow`, with the world given: the dry run's door into the same walk, with no tree. */
export async function walkFlow(checked: CheckedFlow, input: unknown, options: RunFlowOptions, world: World, tree?: string): Promise<FlowResult> {
	const problem = mismatch(input, checked.input);
	if (problem !== undefined) throw new Error(`The input of \`${checked.name}\` does not match its \`input:\`: ${problem}`);

	const started = performance.now();
	const signal = options.signal ?? new AbortController().signal;
	const run = new Run({ ...world, flow: checked, bus: busFor(options), signal, spawn: options.spawn ?? defaultSpawn, model: options.model, timeoutMs: options.timeoutMs });
	const frames = Frames.root();
	let walked: Walked;
	try {
		walked = await run.sequence(checked.nodes, "", { values: Values.root(input), frames, cut: signal, tree });
	} finally {
		await frames.close();
	}
	const usage = sumUsage(walked.usage, performance.now() - started);
	if (walked.failed !== undefined) return { ok: false, error: walked.failed.error, path: walked.failed.path, usage };
	return { ok: true, ...(walked.last?.ok && { output: walked.last.output }), usage };
}
