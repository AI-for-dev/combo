/**
 * How a visit ended, as the nodes after it read it: its output when it ran,
 * why not when it did not, and which visit a failure started at.
 */

import type { ErrorKind, FlowError } from "../checked.ts";

/** A node as it ended: what `x.ok`, `x.output` and `x.error` read. */
export type Ended = { readonly ok: true; readonly output?: unknown } | { readonly ok: false; readonly error: FlowError };

/** The visit a failure started at, and why: what a flow that failed reports. */
export type Failed = { readonly path: string; readonly error: FlowError };

/** A node that could not run. */
export function failure(kind: ErrorKind, message: string): Ended {
	return { ok: false, error: { kind, message } };
}

/**
 * What a node failed by a node inside it ends with: `child`, naming the visit
 * the failure started at and its kind. A person's stop and a `fail-fast` cut
 * came from above, so they keep their own kind on the way up.
 */
export function travelled(failed: Failed): Ended {
	const { kind, message } = failed.error;
	return failure(kind === "stopped" || kind === "cancelled" ? kind : "child", `${failed.path}: ${kind}: ${message}`);
}

/** The visit path of `id` inside the visit `prefix`, `""` at the root. */
export function under(prefix: string, id: string): string {
	return prefix === "" ? id : `${prefix}/${id}`;
}
