/**
 * A checked flow's nodes with the flows it calls unrolled: what the rules
 * about the world read, since a callee acts in its caller's tree through the
 * run's ports. A copy, a commit, a check script or a question nobody can
 * leave unanswered counts where the call stands.
 */

import type { CheckedNode } from "./checked.ts";
import { everyNode } from "./node.ts";

/** A node, at its address through the calls that reach it: `spec/ask_next` for `ask_next` in the flow the node `spec` calls. */
export type Unrolled = { readonly node: CheckedNode; readonly at: string };

/** Every node of `nodes`, nested ones and those of each flow called included, parents first. */
export function* unrolled(nodes: readonly CheckedNode[], prefix = ""): Generator<Unrolled> {
	for (const node of everyNode(nodes)) {
		const at = through(prefix, node.at);
		yield { node, at };
		if (node.kind === "flow") yield* unrolled(node.callee.nodes, at);
	}
}

/** The address `at` through the call at `prefix`, `""` at the root. */
export function through(prefix: string, at: string): string {
	return prefix === "" ? at : `${prefix}/${at}`;
}
