/**
 * How a visit ended, as the nodes after it read it: its output when it ran,
 * why not when it did not, and which visit a failure started at.
 */

import type { Usage } from "../../usage.ts";
import type { ErrorKind, FlowError } from "../checked.ts";

/** A node as it ended: what `x.ok`, `x.output` and `x.error` read. */
export type Ended = { readonly ok: true; readonly output?: unknown } | { readonly ok: false; readonly error: FlowError };

/** The visit a failure started at, and why: what a flow that failed reports. */
export type Failed = { readonly path: string; readonly error: FlowError };

/** How a sequence ended: its last node as it ended, what it cost, and the failure that stopped it. */
export type Walked = { readonly last?: Ended; readonly usage: readonly Usage[]; readonly failed?: Failed };

/** How a visit ended, what it cost, the failure it started from, and for an `agent` visit who ran it. */
export type Visited = { readonly ended: Ended; readonly usage: Usage; readonly failed?: Failed; readonly agent?: string; readonly subagent?: string; readonly model?: string };

/** A node that could not run. */
export function failure(kind: ErrorKind, message: string): Ended {
	return { ok: false, error: { kind, message } };
}

/**
 * What a node failed by a node inside it ends with: `child`, naming the visit
 * the failure started at and its kind. A person's stop and a `fail-fast` cut
 * came from above, so they keep their own kind on the way up.
 */
export function travelled(failed: Failed): Ended & { ok: false } {
	const { kind, message } = failed.error;
	return { ok: false, error: { kind: kind === "stopped" || kind === "cancelled" ? kind : "child", message: `${failed.path}: ${kind}: ${message}` } };
}

/**
 * Why a visit may not go on: the run was stopped, or `cut` fired because a
 * sibling failed under `fail-fast`. The run's stop wins, since `cut` follows it.
 */
export function interruption(run: AbortSignal, cut: AbortSignal): FlowError | undefined {
	if (run.aborted) return { kind: "stopped", message: "the run was stopped" };
	if (cut.aborted) return { kind: "cancelled", message: String(cut.reason) };
	return undefined;
}

/** The visit path of `id` inside the visit `prefix`, `""` at the root. */
export function under(prefix: string, id: string): string {
	return prefix === "" ? id : `${prefix}/${id}`;
}
