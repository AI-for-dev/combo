/**
 * The plan of a checked flow: one line per node, in the tree the file
 * writes, each saying everything the check resolved about it.
 *
 * A line is keyed by the visit path it stands for, with `#n` where a loop
 * numbers its iterations and `[i]` where a `map` numbers its items, so a run
 * can fill the plan as its visits end rather than draw a second picture. A
 * call is one line: its callee's plan is the callee's own.
 */

import type { Agent } from "../../agent.ts";
import { showDuration } from "../../duration.ts";
import { turnTimeout, type Bound } from "../bounds.ts";
import type { CheckedAgentNode, CheckedAskNode, CheckedFlow, CheckedLoopNode, CheckedMapNode, CheckedNode, CheckedRead } from "../checked.ts";
import type { NodeKind } from "../node.ts";
import { showType } from "../type.ts";

/** One line of a plan: a node, a `choice` case or a `parallel` branch, and the lines under it. */
export type PlanLine = {
	/** A node's kind, or a `choice` case, or a `parallel` branch. */
	readonly kind: NodeKind | "case" | "branch";
	/** The node's id, the branch's name, or the case's number, `default` for the last. */
	readonly id: string;
	/** The visit path the line stands for; a case has its choice's, since a case is not a segment of one. */
	readonly path: string;
	/** What was resolved, in the order the file's keys read. */
	readonly facts: readonly string[];
	/** A node's worst case over every visit a run can make of it; a case and a branch have none. */
	readonly bound?: Bound;
	/** The lines under it: a block's sequence, a case's, a branch's. */
	readonly lines: readonly PlanLine[];
};

/** A flow's plan: the flow itself, its worst case whole, and its root sequence. */
export type Plan = {
	/** The flow's name. */
	readonly flow: string;
	/** Its file, its input, and its `model:` and `timeout:` when it sets them. */
	readonly facts: readonly string[];
	/** Its worst case, run whole. */
	readonly bound: Bound;
	/** The root sequence. */
	readonly lines: readonly PlanLine[];
};

/** The plan of `checked`, pure: the same flow gives the same plan. */
export function planOf(checked: CheckedFlow): Plan {
	const { name, file, input, model, timeoutMs, bounds } = checked;
	const facts = [file, `input ${showType(input)}`, ...(model === undefined ? [] : [`model ${model}`]), ...(timeoutMs === undefined ? [] : [`timeout ${showDuration(timeoutMs)}`])];
	return { flow: name, facts, bound: bounds.total, lines: sequence(checked.nodes, "", checked) };
}

function sequence(nodes: readonly CheckedNode[], prefix: string, flow: CheckedFlow): PlanLine[] {
	return nodes.map((node) => line(node, prefix === "" ? node.id : `${prefix}/${node.id}`, flow));
}

function line(node: CheckedNode, path: string, flow: CheckedFlow): PlanLine {
	const { kind, id } = node;
	const own = { kind, id, path, bound: flow.bounds.nodes.get(node.at) };
	const onFail = node.continueOnFail ? ["on-fail continue"] : [];
	switch (node.kind) {
		case "agent":
			return { ...own, facts: [...agentFacts(node, flow), ...onFail], lines: [] };
		case "check":
			return { ...own, facts: [`check ${node.script}`, `timeout ${showDuration(node.timeoutMs)}`, ...onFail], lines: [] };
		case "commit":
			return { ...own, facts: [`commit ${node.message}`, ...onFail], lines: [] };
		case "ask":
			return { ...own, facts: [...askFacts(node), ...onFail], lines: [] };
		case "flow":
			return { ...own, facts: [`flow ${node.callee.name} (${node.callee.file})`, `input ${node.input.address}`, ...onFail], lines: [] };
		case "choice": {
			const cases = node.cases.map((one, i) => ({ id: String(i + 1), facts: [`when ${one.when.source.trim()}`], nodes: one.nodes }));
			const lines = [...cases, { id: "default", facts: [], nodes: node.otherwise }].map((one) => ({ kind: "case" as const, id: one.id, path, facts: one.facts, lines: sequence(one.nodes, path, flow) }));
			return { ...own, facts: [`choice of ${node.cases.length} case${node.cases.length === 1 ? "" : "s"}`, ...onFail], lines };
		}
		case "parallel": {
			const lines = node.branches.map((branch) => ({ kind: "branch" as const, id: branch.name, path: `${path}/${branch.name}`, facts: [], lines: sequence(branch.nodes, `${path}/${branch.name}`, flow) }));
			return { ...own, facts: ["parallel", ...blockFacts(node), ...onFail], lines };
		}
		case "map":
			return { ...own, facts: [...mapFacts(node), ...onFail], lines: sequence(node.nodes, `${path}[i]`, flow) };
		case "loop":
			return { ...own, facts: [...loopFacts(node), ...onFail], lines: sequence(node.nodes, `${path}#n`, flow) };
	}
}

function agentFacts(node: CheckedAgentNode, flow: CheckedFlow): string[] {
	const who = "from" in node.agent ? `agent from ${node.agent.from}: ${[...node.agent.among.values()].map(origin).join(", ")}` : `agent ${origin(node.agent)}`;
	const timeout = turnTimeout(node, flow.timeoutMs);
	return [
		who,
		...reads(node.reads),
		...(node.verdict !== undefined ? [`verdict to ${node.verdict}`] : node.output === undefined ? [] : [`output ${showType(node.output)}`]),
		...(node.memory === undefined ? [] : [`memory ${node.memory}`]),
		...(node.retry > 0 ? [`retry ${node.retry}`] : []),
		`timeout ${showDuration(timeout.ms)}${timeout.from === "node" ? "" : timeout.from === "flow" ? " from the flow" : " by default"}`,
	];
}

function askFacts(node: CheckedAskNode): string[] {
	const question = "text" in node.question ? `ask ${JSON.stringify(node.question.text)}` : `ask from ${node.question.from}`;
	const options = node.options === undefined ? "" : `: ${node.options.map((one) => one.label).join(", ")}`;
	return [
		question,
		`${node.form}${options}`,
		...(node.enough === undefined ? [] : [`enough ${JSON.stringify(node.enough)}`]),
		...(node.default === undefined ? [] : [`default ${JSON.stringify(node.default)}`]),
		...reads(node.reads),
		...(node.timeoutMs === undefined ? [] : [`timeout ${showDuration(node.timeoutMs)}`]),
	];
}

function mapFacts(node: CheckedMapNode): string[] {
	const over = "items" in node.over ? `map ${node.over.items.join(", ")}` : `map from ${node.over.from}, max ${node.max}`;
	return [over, ...(node.concurrency > 1 ? [`concurrency ${node.concurrency}`] : []), ...blockFacts(node), ...(node.ledger ? ["ledger"] : [])];
}

function loopFacts(node: CheckedLoopNode): string[] {
	return [
		`loop until ${node.until.source.trim()}`,
		`max ${node.max}`,
		...(node.giveUp === undefined ? [] : [`give-up ${node.giveUp.source.trim()}`]),
		...(node.carry === undefined ? [] : [`carry ${node.carry.first}, then ${node.carry.next}`]),
		...(node.ledger ? ["ledger"] : []),
	];
}

function blockFacts(node: { readonly copies: boolean; readonly failFast: boolean }): string[] {
	return [...(node.copies ? ["copies"] : []), ...(node.failFast ? ["fail-fast"] : [])];
}

function reads(list: readonly CheckedRead[]): string[] {
	return list.length === 0 ? [] : [`reads ${list.map((one) => one.address).join(", ")}`];
}

/** An agent and the file it was read from. */
function origin(agent: Agent): string {
	return `${agent.name} (${agent.filePath})`;
}
