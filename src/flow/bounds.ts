/**
 * The worst case of a checked flow, computed before the first spawn: how
 * many agent turns each node can ask for, and how long it can take when
 * every bounded wait runs to its bound.
 *
 * Every loop and every `map` has a bound written in the file, so both are
 * known. They are shown, never judged: nothing refuses a flow for what it
 * could cost. Sub-flows are unrolled, since a callee's turns are spent where
 * its call stands, and its agents inherit the caller's `timeout:`.
 */

import type { CheckedAgentNode, CheckedNode } from "./checked.ts";
import { through } from "./unrolled.ts";

/** An agent turn's bound when neither the node, nor the flow, nor a flow calling it sets one. */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * The most something can cost. `ms` counts every wait that has a bound: an
 * agent turn's `timeout:` for each attempt `retry:` allows, a check's, an
 * ask's when it has one. `waits` says an `ask` with no `timeout:` can be
 * reached, whose wait for a person no bound covers.
 */
export type Bound = {
	/** Agent turns, every retry counted. */
	readonly turns: number;
	/** Every bounded wait run to its bound, in milliseconds. */
	readonly ms: number;
	/** Whether an `ask` with no `timeout:` can be reached. */
	readonly waits: boolean;
};

/** A flow's worst case whole, and each node's over every visit a run can make of it. */
export type Bounds = {
	/** The flow's, run whole. */
	readonly total: Bound;
	/** By the node's address through the calls, `spec/look` for `look` in the flow `spec` calls. */
	readonly nodes: ReadonlyMap<string, Bound>;
};

/** Where a sequence stands: how often it is visited, how many of those visits follow each other, and the `timeout:` inherited. */
type Around = { readonly prefix: string; readonly visits: number; readonly waves: number; readonly timeoutMs?: number };

const NOTHING: Bound = { turns: 0, ms: 0, waits: false };

/** The bounds of a flow whose root sequence is `nodes`, run on its own with the flow's `timeout:`. */
export function boundsOf(nodes: readonly CheckedNode[], timeoutMs?: number): Bounds {
	const into = new Map<string, Bound>();
	const total = sequence(nodes, { prefix: "", visits: 1, waves: 1, timeoutMs }, into);
	return { total, nodes: into };
}

/**
 * The bound of one attempt of `node`: its own `timeout:`, the nearest flow's
 * around it, or {@link DEFAULT_TIMEOUT_MS}, and which of the three it is.
 */
export function turnTimeout(node: CheckedAgentNode, flowMs?: number): { readonly ms: number; readonly from: "node" | "flow" | "default" } {
	if (node.timeoutMs !== undefined) return { ms: node.timeoutMs, from: "node" };
	return flowMs === undefined ? { ms: DEFAULT_TIMEOUT_MS, from: "default" } : { ms: flowMs, from: "flow" };
}

/** How many items a `map` runs at most: its literal list, or its `max:`. */
export function itemsOf(node: Extract<CheckedNode, { kind: "map" }>): number {
	return "items" in node.over ? node.over.items.length : (node.max as number);
}

/** One visit of a sequence: its nodes one after the other. */
function sequence(nodes: readonly CheckedNode[], around: Around, into: Map<string, Bound>): Bound {
	return nodes.reduce((sum, node) => after(sum, one(node, around, into)), NOTHING);
}

/** One visit of `node`, written into `into` for every visit `around` makes. */
function one(node: CheckedNode, around: Around, into: Map<string, Bound>): Bound {
	const at = through(around.prefix, node.at);
	const bound = visit(node, around, into);
	into.set(at, { turns: bound.turns * around.visits, ms: bound.ms * around.waves, waits: bound.waits });
	return bound;
}

function visit(node: CheckedNode, around: Around, into: Map<string, Bound>): Bound {
	const inside = (nodes: readonly CheckedNode[], visits = 1, waves = visits) => sequence(nodes, { ...around, visits: around.visits * visits, waves: around.waves * waves }, into);
	switch (node.kind) {
		case "agent": {
			const attempts = 1 + node.retry;
			return { turns: attempts, ms: attempts * turnTimeout(node, around.timeoutMs).ms, waits: false };
		}
		case "check":
			return { ...NOTHING, ms: node.timeoutMs };
		case "commit":
			return NOTHING;
		case "ask":
			return { ...NOTHING, ms: node.timeoutMs ?? 0, waits: node.timeoutMs === undefined };
		case "flow":
			return sequence(node.callee.nodes, { ...around, prefix: through(around.prefix, node.at), timeoutMs: node.callee.timeoutMs ?? around.timeoutMs }, into);
		case "choice":
			// One case runs, and which is decided at run time: the worst of each.
			return [...node.cases.map((one) => one.nodes), node.otherwise].map((nodes) => inside(nodes)).reduce(worst, NOTHING);
		case "parallel":
			return node.branches.map((branch) => inside(branch.nodes)).reduce(together, NOTHING);
		case "map": {
			const items = itemsOf(node);
			const waves = Math.ceil(items / node.concurrency);
			const body = inside(node.nodes, items, waves);
			return { turns: body.turns * items, ms: body.ms * waves, waits: body.waits };
		}
		case "loop": {
			const body = inside(node.nodes, node.max);
			return { turns: body.turns * node.max, ms: body.ms * node.max, waits: body.waits };
		}
	}
}

function after(a: Bound, b: Bound): Bound {
	return { turns: a.turns + b.turns, ms: a.ms + b.ms, waits: a.waits || b.waits };
}

function worst(a: Bound, b: Bound): Bound {
	return { turns: Math.max(a.turns, b.turns), ms: Math.max(a.ms, b.ms), waits: a.waits || b.waits };
}

/** Branches running at once: their turns add up, their time does not. */
function together(a: Bound, b: Bound): Bound {
	return { turns: a.turns + b.turns, ms: Math.max(a.ms, b.ms), waits: a.waits || b.waits };
}

/** A duration the way a flow file writes one, largest units first: `1h30m`, `90s` reads `1m30s`. */
export function showDuration(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	const parts: [number, string][] = [
		[Math.floor(seconds / 3600), "h"],
		[Math.floor((seconds % 3600) / 60), "m"],
		[seconds % 60, "s"],
	];
	const shown = parts.filter(([n]) => n > 0).map(([n, unit]) => `${n}${unit}`);
	return shown.length === 0 ? "0s" : shown.join("");
}

/** A bound as a plan line shows it: `≤ 4 turns · ≤ 2h`, and a person's answer when an ask with no `timeout:` waits for one. */
export function showBound({ turns, ms, waits }: Bound): string {
	const time = [...(ms > 0 ? [`≤ ${showDuration(ms)}`] : []), ...(waits ? ["a person's answer"] : [])].join(" + ");
	return [...(turns > 0 ? [`≤ ${turns} turn${turns === 1 ? "" : "s"}`] : []), ...(time === "" ? [] : [time])].join(" · ");
}
