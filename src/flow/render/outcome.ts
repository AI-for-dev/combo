/**
 * How an ended visit reads on its one line, and whether it ended the
 * sequence it was in: the two readings of a `visit_end` the live view makes.
 */

import { plural } from "../../text.ts";
import type { CheckedNode } from "../checked.ts";
import type { VisitEnd } from "../run/index.ts";

/**
 * What the one line of an ended visit says: why it failed, or the agent that
 * ran it, the case a `choice` took, the iterations of a loop and whether it
 * converged, how many items or branches a block joined and how many of them
 * failed under `on-fail: continue`.
 */
export function outcome(node: CheckedNode, end: VisitEnd): string[] {
	if (!end.ok) return end.error === undefined ? [] : [`${end.error.kind}: ${end.error.message}`];
	switch (node.kind) {
		case "agent":
			return end.agent === undefined ? [] : [end.agent];
		case "choice":
			return end.case === undefined ? [] : [end.case === "default" ? "default" : `case ${end.case}`];
		case "loop": {
			const { iterations } = end.output as { iterations: number };
			return [plural(iterations, "iteration"), ...(end.converged === false ? ["not converged"] : [])];
		}
		case "map": {
			const items = end.output as readonly { ok: boolean }[];
			return [plural(items.length, "item"), ...failedOf(items)];
		}
		case "parallel": {
			const branches = Object.values(end.output as Record<string, { ok: boolean }>);
			return [`${branches.length} branch${branches.length === 1 ? "" : "es"}`, ...failedOf(branches)];
		}
		default:
			return [];
	}
}

/**
 * Whether `end` stopped the sequence `node` is in, as the walk decides it:
 * a failure `on-fail: continue` does not absorb, and a stop or a cut, which
 * nothing absorbs.
 */
export function stopsSequence(node: CheckedNode, end: VisitEnd): boolean {
	const kind = end.error?.kind;
	return !end.ok && (!node.continueOnFail || kind === "stopped" || kind === "cancelled");
}

/** `1 failed`, when any of `ends` did. */
function failedOf(ends: readonly { ok: boolean }[]): string[] {
	const failed = ends.filter((one) => !one.ok).length;
	return failed === 0 ? [] : [`${failed} failed`];
}
