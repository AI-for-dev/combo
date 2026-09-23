/**
 * Where a dry run's key lands: the `agent`, `check`, `commit`, `ask` or
 * `flow` node it names, and the most answers a list under it can be asked for.
 *
 * A node's address (`review/code`) is answered within its enclosing path, so
 * every iteration of every loop around it draws on one list, and each attempt
 * `retry:` allows takes one answer. An exact visit path
 * (`deliver#2/work[1]/review#3/code`) is one visit, and walking it holds each
 * iteration and each item to the bound its block has. A `flow` node is
 * answered whole by a key on it, or walked into by keys under it, whose
 * addresses go through the call: `spec/ask_next`.
 */

import type { CheckedAgentNode, CheckedAskNode, CheckedCallNode, CheckedCheckNode, CheckedCommitNode, CheckedNode } from "../checked.ts";
import { nearest } from "../fault.ts";
import { under } from "./ended.ts";

/** A node a script answers: an agent turn, a check's script run, a commit, a question, or a call whole. */
export type AnsweredNode = CheckedAgentNode | CheckedCheckNode | CheckedCommitNode | CheckedAskNode | CheckedCallNode;

/** The node a key names, its address through the calls, and how many answers its list can be asked for. */
export type Keyed = { readonly node: AnsweredNode; readonly at: string; readonly most: number };

/** Why a key names no visit: a path that leads nowhere, or an iteration or item past its bound. */
export type Unkeyed = { readonly code: "answer-unknown-node" | "answer-past-max"; readonly why?: string };

/**
 * Every answered node by address, each asked at most once per attempt per
 * iteration of the loops around it, a callee's inside its call's `prefix`.
 */
export function answeredNodes(nodes: readonly CheckedNode[], loops = 1, into = new Map<string, Keyed>(), prefix = ""): Map<string, Keyed> {
	for (const node of nodes) {
		const at = under(prefix, node.at);
		if (!isAnswered(node)) for (const inner of nested(node)) answeredNodes(inner, node.kind === "loop" ? loops * node.max : loops, into, prefix);
		else into.set(at, { node, at, most: loops * attempts(node) });
		if (node.kind === "flow") answeredNodes(node.callee.nodes, loops, into, at);
	}
	return into;
}

/** The visit `path` names, walked down from `nodes`, when it is one a script answers. */
export function visitAt(nodes: readonly CheckedNode[], path: string): Keyed | Unkeyed {
	const found = nodeAt(nodes, path);
	if ("code" in found) return found;
	return isAnswered(found.node) ? { node: found.node, at: found.at, most: attempts(found.node) } : { code: "answer-unknown-node" };
}

/**
 * The node whose visit `path` names, of any kind, and its address through the
 * calls. Each loop the path goes through numbers its iteration `#n` and each
 * `map` its item `[i]`, within their bounds; a loop's or a map's own visit is
 * named without.
 */
export function nodeAt(nodes: readonly CheckedNode[], path: string): { readonly node: CheckedNode; readonly at: string } | Unkeyed {
	const segments = path.split("/");
	let here = nodes;
	let prefix = "";
	for (let i = 0; i < segments.length; i++) {
		const [, id, iteration, item] = /^(\w+)(?:#(\d+)|\[(\d+)\])?$/.exec(segments[i] as string) ?? [];
		const node = here.find((one) => one.id === id);
		if (node === undefined) return { code: "answer-unknown-node" };
		const last = i === segments.length - 1;
		const numbered = last ? undefined : node.kind;
		if ((numbered === "loop") !== (iteration !== undefined) || (numbered === "map") !== (item !== undefined)) {
			return { code: "answer-unknown-node", why: "a visit path numbers each loop iteration `#n` and each map item `[i]`, and nothing else" };
		}
		const bound = node.kind === "loop" ? node.max : node.kind === "map" ? ("items" in node.over ? node.over.items.length : (node.max as number)) : 1;
		const number = Number(iteration ?? item ?? 1);
		if (number < 1 || number > bound) {
			return { code: "answer-past-max", why: `\`${id}\` runs ${bound} ${node.kind === "loop" ? "iterations" : "items"} at most, numbered from 1` };
		}
		if (last) return { node, at: under(prefix, node.at) };
		if (node.kind === "flow") {
			prefix = under(prefix, node.at);
			here = node.callee.nodes;
		} else if (isAnswered(node)) {
			return { code: "answer-unknown-node" };
		} else if (node.kind === "parallel") {
			const branch = node.branches.find((one) => one.name === segments[++i]);
			if (branch === undefined) return { code: "answer-unknown-node", why: `a visit inside \`${id}\` names its branch: ${node.branches.map((one) => one.name).join(", ")}` };
			here = branch.nodes;
		} else {
			here = nested(node).flat();
		}
	}
	return { code: "answer-unknown-node" };
}

/** The keys under a call another key answers whole, each with that key: none of them would be asked. */
export function overlaps(keys: ReadonlyMap<string, Keyed>): { readonly key: string; readonly whole: string }[] {
	const wholes = [...keys].filter(([, keyed]) => keyed.node.kind === "flow");
	return [...keys].flatMap(([key, { at }]) => {
		const [whole] = wholes.find(([, call]) => at.startsWith(`${call.at}/`)) ?? [];
		return whole === undefined ? [] : [{ key, whole }];
	});
}

/** Why `key` names no visit, offering the address meant when it can. */
export function unkeyed(key: string, { code, why }: Unkeyed, nodes: ReadonlyMap<string, Keyed>): string {
	if (code === "answer-past-max") return `\`${key}\`: ${why}`;
	// An id alone is the likeliest slip: it is how the node is written.
	const near = [...nodes.values()].find(({ node }) => node.id === key)?.at ?? nearest(key.replace(/#\d+|\[\d+\]/g, ""), nodes.keys());
	const said = why ?? (near === undefined ? undefined : `did you mean \`${near}\`?`);
	return `\`${key}\` names no agent, check, commit, ask or flow node${said === undefined ? "" : `: ${said}`}`;
}

function isAnswered(node: CheckedNode): node is AnsweredNode {
	return node.kind === "agent" || node.kind === "check" || node.kind === "commit" || node.kind === "ask" || node.kind === "flow";
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
