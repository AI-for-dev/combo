/**
 * A run as a tree: a delegated subagent drawn under the one that asked for it.
 */

import type { SubagentSnapshot } from "./picture.ts";

/**
 * Launch order, rearranged so that a child follows the parent it hangs under.
 *
 * The snapshot itself stays flat, and this is why: every existing reader keeps
 * working, and the one that wants a tree asks for it here. A delegating run
 * spawns its children after their parent anyway, so with a single root the
 * order barely moves; with two parents working at once it stops interleaving
 * three readers of one explorer with three of the other.
 *
 * **Nothing is ever dropped.** A subagent whose parent is not in the list - a
 * reporter attached mid-run, a snapshot assembled by hand - is placed as a
 * root, and anything the walk could not reach is appended rather than lost. A
 * measurement that silently omits a subagent is worse than one that misplaces
 * it. How deep each one is drawn is its own `depth`, decided when it spawned.
 */
export function treeOrder(subagents: readonly SubagentSnapshot[]): SubagentSnapshot[] {
	const known = new Set(subagents.map((one) => one.id));
	const childrenOf = new Map<string, SubagentSnapshot[]>();
	for (const one of subagents) {
		const parent = one.parentId && known.has(one.parentId) ? one.parentId : ROOT;
		const siblings = childrenOf.get(parent);
		if (siblings) siblings.push(one);
		else childrenOf.set(parent, [one]);
	}

	const rows: SubagentSnapshot[] = [];
	const seen = new Set<string>();
	const walk = (parent: string) => {
		for (const one of childrenOf.get(parent) ?? []) {
			if (seen.has(one.id)) continue;
			seen.add(one.id);
			rows.push(one);
			walk(one.id);
		}
	};
	walk(ROOT);

	for (const one of subagents) {
		if (!seen.has(one.id)) rows.push(one);
	}
	return rows;
}

/** The bucket a subagent with no reachable parent goes in. No id can collide with it. */
const ROOT = "";
