/**
 * The subagents a flow's memory scopes hold: one per agent per scope, shared
 * by every node naming both.
 *
 * A subagent is spawned with its tools, so the `submit` tool it answers a
 * typed node with is fixed for its whole life, and the nodes sharing it must
 * agree on what they submit. That is read here, from the checked nodes alone:
 * the check stage refuses a disagreement, and the runner builds the one tool.
 */

import type { CheckedAgentNode, CheckedNode } from "./checked.ts";
import type { FaultList } from "./fault.ts";
import { everyNode } from "./node.ts";
import { sameType, type ValueType } from "./type.ts";

/** The key of the subagent `agent` keeps in `scope`, a node id or `flow`. */
export function sharedKey(scope: string, agent: string): string {
	return `${scope}/${agent}`;
}

/** The names of the agents a node may run: one, or every agent `among:` names. */
export function agentsOf(node: CheckedAgentNode): string[] {
	return "from" in node.agent ? [...node.agent.among.keys()] : [node.agent.name];
}

/** Every node with a `memory:` scope, by the subagent it shares. */
export function sharedSubagents(nodes: readonly CheckedNode[]): Map<string, CheckedAgentNode[]> {
	const shared = new Map<string, CheckedAgentNode[]>();
	for (const node of everyNode(nodes)) {
		if (node.kind !== "agent" || node.memory === undefined) continue;
		for (const agent of agentsOf(node)) {
			const key = sharedKey(node.memory, agent);
			shared.set(key, [...(shared.get(key) ?? []), node]);
		}
	}
	return shared;
}

/** What a shared subagent submits: the output its typed nodes declare. */
export function submitted(sharing: readonly CheckedAgentNode[]): ValueType | undefined {
	return sharing.find((node) => node.output !== undefined)?.output;
}

/** Refuses nodes that share a subagent and declare different outputs. */
export function checkShared(nodes: readonly CheckedNode[], faults: FaultList): void {
	const reported = new Set<string>();
	for (const [key, sharing] of sharedSubagents(nodes)) {
		const first = sharing.find((node) => node.output !== undefined);
		for (const node of sharing) {
			if (first === undefined || node.output === undefined || sameType(node.output, first.output as ValueType) || reported.has(node.at)) continue;
			reported.add(node.at);
			const agent = key.slice(key.indexOf("/") + 1);
			faults.add("memory-output-mismatch", `${node.at}.output`, `\`${node.id}\` and \`${first.id}\` share the \`${agent}\` subagent of \`${node.memory}\`, whose one \`submit\` tool cannot take both outputs: declare the same one, or use another scope`);
		}
	}
}
