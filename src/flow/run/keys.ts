/**
 * Where a dry run's key lands: the `agent`, `check`, `commit` or `ask` node
 * it names, and the most answers a list under it can be asked for.
 *
 * A node's address (`review/code`) is answered within its enclosing path, so
 * every iteration of every loop around it draws on one list, and each attempt
 * `retry:` allows takes one answer. An exact visit path
 * (`deliver#2/work[1]/review#3/code`) is one visit, and walking it holds each
 * iteration and each item to the bound its block has.
 */

import type { CheckedAgentNode, CheckedAskNode, CheckedCheckNode, CheckedCommitNode, CheckedNode } from "../checked.ts";

/** A node a script answers: an agent turn, a check's script run, a commit, or a question. */
export type AnsweredNode = CheckedAgentNode | CheckedCheckNode | CheckedCommitNode | CheckedAskNode;

/** The node a key names, and how many answers its list can be asked for. */
export type Keyed = { readonly node: AnsweredNode; readonly most: number };

/** Why a key names no visit: a path that leads nowhere, or an iteration or item past its bound. */
export type Unkeyed = { readonly code: "answer-unknown-node" | "answer-past-max"; readonly why?: string };

/** Every answered node by address, each asked at most once per attempt per iteration of the loops around it. */
export function answeredNodes(nodes: readonly CheckedNode[], loops = 1, into = new Map<string, Keyed>()): Map<string, Keyed> {
	for (const node of nodes) {
		if (isAnswered(node)) into.set(node.at, { node, most: loops * attempts(node) });
		else for (const inner of nested(node)) answeredNodes(inner, node.kind === "loop" ? loops * node.max : loops, into);
	}
	return into;
}

/** The visit `path` names, walked down from `nodes`. */
export function visitAt(nodes: readonly CheckedNode[], path: string): Keyed | Unkeyed {
	const segments = path.split("/");
	let here = nodes;
	for (let i = 0; i < segments.length; i++) {
		const [, id, iteration, item] = /^(\w+)(?:#(\d+)|\[(\d+)\])?$/.exec(segments[i] as string) ?? [];
		const node = here.find((one) => one.id === id);
		if (node === undefined) return { code: "answer-unknown-node" };
		if ((node.kind === "loop") !== (iteration !== undefined) || (node.kind === "map") !== (item !== undefined)) {
			return { code: "answer-unknown-node", why: "a visit path numbers each loop iteration `#n` and each map item `[i]`, and nothing else" };
		}
		const bound = node.kind === "loop" ? node.max : node.kind === "map" ? ("items" in node.over ? node.over.items.length : (node.max as number)) : 1;
		const number = Number(iteration ?? item ?? 1);
		if (number < 1 || number > bound) {
			return { code: "answer-past-max", why: `\`${id}\` runs ${bound} ${node.kind === "loop" ? "iterations" : "items"} at most, numbered from 1` };
		}
		if (isAnswered(node)) return i === segments.length - 1 ? { node, most: attempts(node) } : { code: "answer-unknown-node" };
		if (node.kind === "parallel") {
			const branch = node.branches.find((one) => one.name === segments[++i]);
			if (branch === undefined) return { code: "answer-unknown-node", why: `a visit inside \`${id}\` names its branch: ${node.branches.map((one) => one.name).join(", ")}` };
			here = branch.nodes;
		} else {
			here = nested(node).flat();
		}
	}
	return { code: "answer-unknown-node" };
}

function isAnswered(node: CheckedNode): node is AnsweredNode {
	return node.kind === "agent" || node.kind === "check" || node.kind === "commit" || node.kind === "ask";
}

/** How many times one visit of `node` is asked: only an agent turn is retried. */
function attempts(node: AnsweredNode): number {
	return node.kind === "agent" ? 1 + node.retry : 1;
}

function nested(node: Exclude<CheckedNode, AnsweredNode>): (readonly CheckedNode[])[] {
	switch (node.kind) {
		case "choice":
			return [...node.cases.map((one) => one.nodes), node.otherwise];
		case "parallel":
			return node.branches.map((one) => one.nodes);
		default:
			return [node.nodes];
	}
}
