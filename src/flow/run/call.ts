/**
 * One visit of a `flow` node: its callee walked under the call's visit path,
 * `spec/interview#3/ask_next`, from its first node to its last.
 *
 * The boundary is the memory scopes, the ledgers and the values: the callee
 * opens a `flow` scope of its own, closed when the visit ends, reads nothing
 * but the `input` it is handed, and hands back its last root node's output.
 * The world has none: the callee acts in the visit's tree, through the run's
 * ports. A callee that fails ends the call `child`, as any node failed by a
 * node inside it.
 */

import type { GitResult } from "../../git/index.ts";
import { emptyUsage, sumUsage } from "../../usage.ts";
import type { CheckedCallNode, CheckedFlow } from "../checked.ts";
import { failure, travelled, type Ended, type Visited, type Walked } from "./ended.ts";
import { Frames } from "./frames.ts";
import { withDiff } from "./reads.ts";
import { Values } from "./values.ts";
import type { Here, Walker } from "./walk.ts";

/** What a call visit needs from the run around it. */
export type CallingRun = {
	/** What `tree` changed since `HEAD`, when the call hands in `diff`. */
	diff(tree: string | undefined): Promise<GitResult<string>>;
	/** The run one call further down: the callee's `model:` and `timeout:` first, its nodes told by their address through the call. */
	called(node: CheckedCallNode): Walker;
	/** The call answered whole, when a dry run's script says so. */
	whole(node: CheckedCallNode, path: string): Ended | undefined;
};

/** Visits `node` at `path`. */
export async function visitCall(run: CallingRun, node: CheckedCallNode, path: string, at: Here): Promise<Visited> {
	const scripted = run.whole(node, path);
	if (scripted !== undefined) return { ended: scripted, usage: emptyUsage() };
	const here = await withDiff((tree) => run.diff(tree), [node.input], at);
	if (typeof here === "string") return { ended: failure("unavailable", here), usage: emptyUsage() };
	const read = here.values.need(node.input.address);
	if (!read.ok) return { ended: failure("condition", `\`input: ${node.input.address}\`: ${read.message}`), usage: emptyUsage() };
	const walked = await walkWhole(run.called(node), node.callee, path, handed(node.callee, read.value), here);
	const usage = sumUsage(walked.usage, 0);
	if (walked.failed !== undefined) return { ended: travelled(walked.failed), usage, failed: walked.failed };
	return { ended: { ok: true, ...(walked.last?.ok && { output: walked.last.output }) }, usage };
}

/**
 * `flow` walked on `input` inside the visit `prefix`, in memory scopes of its
 * own, closed when it ends: the run's root, and every call.
 */
export async function walkWhole(walker: Walker, flow: CheckedFlow, prefix: string, input: unknown, { cut, tree }: Pick<Here, "cut" | "tree">): Promise<Walked> {
	const frames = Frames.root(prefix);
	try {
		return await walker.sequence(flow.nodes, prefix, { values: Values.root(input), frames, cut, tree });
	} finally {
		await frames.close();
	}
}

/** What a callee reads as `input`: the value, or, for a text input, a typed value as JSON, the way a turn shows one. */
function handed(callee: CheckedFlow, value: unknown): unknown {
	return callee.input.kind === "string" && typeof value !== "string" ? JSON.stringify(value, null, 2) : value;
}
