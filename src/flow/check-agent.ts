/**
 * Checking an `agent` node: the agent it runs, named or picked by a value
 * within a closed set, the scopes it names, what it reads, and its prose.
 */

import type { Agent } from "../agent.ts";
import type { CheckedOne, Checker } from "./check.ts";
import { VERDICT, type CheckedAgentNode } from "./checked.ts";
import type { AgentNode } from "./node.ts";
import type { Scope } from "./scope.ts";
import { showType } from "./type.ts";

/** `node` in `scope`, and what it outputs whether it passed or not: its schema, a verdict, or its text. */
export function checkAgent(checker: Checker, node: AgentNode, scope: Scope): CheckedOne {
	const output = node.verdict !== undefined ? VERDICT : (node.output ?? { kind: "text" });
	const { faults } = checker;
	const agent = "name" in node.agent ? checker.agents.resolve(node.agent.name, `${node.at}.agent`, faults) : picked(checker, node, node.agent.from, node.agent.among, scope);
	if (node.memory !== undefined && node.memory !== "flow" && !scope.encloses(node.memory)) {
		faults.add("unknown-scope", `${node.at}.memory`, `\`${node.memory}\` is not a node this one is in; \`memory:\` names one, or \`flow\` for the whole file`);
	}
	if (node.memory !== undefined && scope.outsideCopies(node.memory)) {
		faults.add("memory-outside-copies", `${node.at}.memory`, `\`${node.memory}\` opens outside the \`copies: true\` block this node is in, so its subagent would work in another tree than this branch's copy: name a scope inside the block`);
	}
	if (node.verdict !== undefined && !scope.keepsLedger(node.verdict)) {
		faults.add("unknown-scope", `${node.at}.verdict`, `\`${node.verdict}\` is not a node this one is in with a \`ledger:\`; \`verdict:\` names the one whose ledger it writes to`);
	}
	const reads = node.reads.map((address) => checker.read(address, `${node.at}.reads`, scope)).filter((read) => read !== undefined);
	if (agent === undefined) return { output };
	const { id, at, memory, verdict, retry, timeoutMs, continueOnFail } = node;
	return { output, node: { kind: "agent", id, at, agent, prose: checker.prose(id), memory, reads, output: node.output, verdict, retry, timeoutMs, continueOnFail } satisfies CheckedAgentNode };
}

/** `agent-from:` reads an enum, and `among:` names exactly its values, each an agent. */
function picked(checker: Checker, node: AgentNode, from: string, among: readonly string[], scope: Scope): CheckedAgentNode["agent"] | undefined {
	const at = `${node.at}.agent-from`;
	const type = checker.typeOf(from, at, scope);
	const agents = new Map<string, Agent>();
	for (const name of among) {
		const agent = checker.agents.resolve(name, `${node.at}.among`, checker.faults);
		if (agent !== undefined) agents.set(name, agent);
	}
	if (type === undefined) return undefined;
	if (type.kind !== "enum") {
		checker.faults.add("key-type", at, `\`${from}\` is ${showType(type)}; \`agent-from:\` reads an enum, whose values \`among:\` names`);
		return undefined;
	}
	const unnamed = type.values.filter((value) => !among.includes(value));
	const stray = among.filter((name) => !type.values.includes(name));
	if (unnamed.length > 0 || stray.length > 0) {
		const said = [unnamed.length > 0 && `\`${from}\` can be ${unnamed.join(", ")}, which \`among:\` does not name`, stray.length > 0 && `${stray.join(", ")} is not a value of ${showType(type)}`];
		checker.faults.add("among-mismatch", `${node.at}.among`, said.filter(Boolean).join("; "));
	}
	return { from, among: agents };
}
