/**
 * `runFlow`: a checked flow run from its first node to its last.
 *
 * It takes a `CheckedFlow` and nothing else, so an unchecked file cannot
 * reach a spawn. What the run needs from the world arrives as options, until
 * the run stage checks a working directory and its ports into a `CheckedRun`,
 * which this signature will take in place of the flow.
 */

import { busFor, type EventListener } from "../../events.ts";
import { spawn as defaultSpawn } from "../../subagent.ts";
import { sumUsage, type Usage } from "../../usage.ts";
import type { SpawnFn } from "../../workflows/options.ts";
import type { CheckedFlow, FlowError } from "../checked.ts";
import { everyNode } from "../node.ts";
import { mismatch } from "../type.ts";
import type { Attempt } from "./agent.ts";
import { Frames } from "./frames.ts";
import { Values } from "./values.ts";
import { notYet, Run, type Walked } from "./walk.ts";

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
	/** The bound of every agent turn, over each node's `timeout:` and the flow's. */
	timeoutMs?: number;
	/** Where the subagents work. Defaults to the process's own. */
	cwd?: string;
};

/**
 * How a run ended. `output` is the last root node's; a failure names the
 * visit it started at. `usage` sums every visit, `wallMs` being the run's.
 */
export type FlowResult =
	| { readonly ok: true; readonly output?: unknown; readonly usage: Usage }
	| { readonly ok: false; readonly error: FlowError; readonly path: string; readonly usage: Usage };

/**
 * Runs `checked` on `input`.
 *
 * Throws, before anything is spawned, on an input off the flow's `input:` and
 * on a node this runner does not walk yet: both are the caller's mistake, not
 * a run that went wrong. Every other failure is a result.
 */
export function runFlow(checked: CheckedFlow, input: unknown, options: RunFlowOptions = {}): Promise<FlowResult> {
	return walkFlow(checked, input, options, ({ ms }) => AbortSignal.timeout(ms));
}

/** `runFlow`, with the deadline of each attempt given: the dry run's door into the same walk. */
export async function walkFlow(checked: CheckedFlow, input: unknown, options: RunFlowOptions, deadline: (attempt: Attempt) => AbortSignal): Promise<FlowResult> {
	const refused = [...everyNode(checked.nodes)].find((node) => (node.kind === "agent" ? node.verdict !== undefined : node.kind !== "choice"));
	if (refused !== undefined) throw notYet(refused);
	const problem = mismatch(input, checked.input);
	if (problem !== undefined) throw new Error(`The input of \`${checked.name}\` does not match its \`input:\`: ${problem}`);

	const started = performance.now();
	const signal = options.signal ?? new AbortController().signal;
	const run = new Run({ flow: checked, bus: busFor(options), signal, spawn: options.spawn ?? defaultSpawn, model: options.model, timeoutMs: options.timeoutMs, cwd: options.cwd, deadline });
	const frames = Frames.root();
	let walked: Walked;
	try {
		walked = await run.sequence(checked.nodes, "", Values.root(input), frames);
	} finally {
		await frames.close();
	}
	const usage = sumUsage(walked.usage, performance.now() - started);
	if (walked.failed !== undefined) return { ok: false, error: walked.failed.error, path: walked.failed.path, usage };
	return { ok: true, ...(walked.last?.ok && { output: walked.last.output }), usage };
}
