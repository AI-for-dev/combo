/**
 * The flow stage of validation: a flow read against the catalogue it runs in,
 * before the first spawn.
 *
 * Every name is resolved here (the agents, and the addresses each node reads
 * in its lexical scope) and every fault is returned at once. What passes
 * becomes a `CheckedFlow`, the one thing the runner takes. What depends on the
 * project a run starts in (its working tree, its ports, whether somebody is
 * there) is the run stage's, and is not looked at here.
 */

import type { Agent } from "../agent.ts";
import type { MarkdownFile } from "../markdown.ts";
import { endedNode, type CheckedAgentNode, type CheckedFlow, type CheckedNode, type CheckedRead } from "./checked.ts";
import { typeOfAddress, type Readable } from "./condition/index.ts";
import { FaultList, type Fault } from "./fault.ts";
import { readFlow, type FlowFile } from "./file.ts";
import type { AgentNode } from "./node.ts";
import { showType, type ValueType } from "./type.ts";

/** What a flow is checked against: the flow files by name, and the agents. */
export type FlowCatalogue = {
	/** Flow files, found by their file name without `.md`, which is the flow's name. */
	readonly flows: readonly MarkdownFile[];
	readonly agents: readonly Agent[];
};

/** A checked flow, or every fault that refused it. */
export type CheckFlow = { readonly ok: true; readonly flow: CheckedFlow } | { readonly ok: false; readonly faults: readonly Fault[] };

/**
 * The flow named `name` in `catalogue`, checked.
 *
 * A flow is found by its file name, so a file that does not parse is still
 * found, and reported as broken rather than unknown; its `name:` must say the
 * same.
 */
export function checkFlow(name: string, catalogue: FlowCatalogue): CheckFlow {
	const source = catalogue.flows.find((file) => file.name === name);
	if (source === undefined) {
		const faults = new FaultList("");
		faults.unknown("unknown-flow", "", name, catalogue.flows.map((file) => file.name), "flows");
		return { ok: false, faults: faults.list };
	}
	const { flow, faults } = readFlow(source.content, source.filePath);
	if (flow === undefined) return { ok: false, faults: faults.list };
	if (flow.name !== "" && flow.name !== name) faults.add("name-mismatch", "name", `\`${flow.name}\` is in \`${name}.md\`: a flow is found by its file name, so the two say the same`);
	const nodes = new Scope(flow, catalogue.agents, faults).sequence(flow.nodes);
	faults.sort(flow.rank);
	if (faults.list.length > 0) return { ok: false, faults: faults.list };
	const { file, description, input, model, timeoutMs } = flow;
	return { ok: true, flow: { name, file, description, input, model, timeoutMs, nodes } as unknown as CheckedFlow };
}

/** What a sequence can see while it is checked, node by node. */
class Scope {
	private readonly flow: FlowFile;
	private readonly agents: ReadonlyMap<string, Agent>;
	private readonly faults: FaultList;
	/** Every id of the file, so an address to one not ended yet says so. */
	private readonly ids: ReadonlySet<string>;
	/** What is readable now, by the first word of an address. */
	private readonly readable = new Map<string, ValueType>();
	/** The output of each ended node, which a bare id reads whole. */
	private readonly outputs = new Map<string, ValueType>();

	constructor(flow: FlowFile, agents: readonly Agent[], faults: FaultList) {
		this.flow = flow;
		this.agents = new Map(agents.map((agent) => [agent.name, agent]));
		this.faults = faults;
		this.ids = new Set(flow.nodes.map((node) => node.id));
		this.readable.set("input", flow.input);
		this.outputs.set("input", flow.input);
	}

	sequence(nodes: readonly AgentNode[]): CheckedNode[] {
		const checked: CheckedNode[] = [];
		for (const node of nodes) {
			const before = this.faults.list.length;
			const result = this.agentNode(node);
			if (this.faults.list.length === before) checked.push(result);
			const output = node.output ?? { kind: "text" };
			this.readable.set(node.id, endedNode(output));
			this.outputs.set(node.id, output);
		}
		return checked;
	}

	private agentNode(node: AgentNode): CheckedAgentNode {
		const agent = "name" in node.agent ? this.agent(node.agent.name, `${node.at}.agent`) : this.picked(node, node.agent.from, node.agent.among);
		if (node.memory !== undefined && node.memory !== "flow") {
			this.faults.add("unknown-scope", `${node.at}.memory`, `\`${node.memory}\` is not an enclosing node; \`memory:\` names one, or \`flow\` for the whole file`);
		}
		const reads = node.reads.map((address) => this.read(address, `${node.at}.reads`)).filter((read) => read !== undefined);
		const prose = this.flow.sections.get(node.id) ?? "";
		const { id, at, memory, output, retry, timeoutMs, continueOnFail } = node;
		return { kind: "agent", id, at, agent: agent as CheckedAgentNode["agent"], prose, memory, reads, output, retry, timeoutMs, continueOnFail };
	}

	/** `agent-from:` reads an enum, and `among:` names exactly its values, each an agent. */
	private picked(node: AgentNode, from: string, among: readonly string[]): CheckedAgentNode["agent"] | undefined {
		const at = `${node.at}.agent-from`;
		const type = this.typeOf(from, at);
		const agents = new Map<string, Agent>();
		for (const name of among) {
			const agent = this.agent(name, `${node.at}.among`);
			if (agent !== undefined) agents.set(name, agent);
		}
		if (type === undefined) return undefined;
		if (type.kind !== "enum") {
			this.faults.add("key-type", at, `\`${from}\` is ${showType(type)}; \`agent-from:\` reads an enum, whose values \`among:\` names`);
			return undefined;
		}
		const unnamed = type.values.filter((value) => !among.includes(value));
		const stray = among.filter((name) => !type.values.includes(name));
		if (unnamed.length > 0 || stray.length > 0) {
			const said = [unnamed.length > 0 && `\`${from}\` can be ${unnamed.join(", ")}, which \`among:\` does not name`, stray.length > 0 && `${stray.join(", ")} is not a value of ${showType(type)}`];
			this.faults.add("among-mismatch", `${node.at}.among`, said.filter(Boolean).join("; "));
		}
		return { from, among: agents };
	}

	private agent(name: string, at: string): Agent | undefined {
		const agent = this.agents.get(name);
		if (agent === undefined) this.faults.unknown("unknown-agent", at, name, [...this.agents.keys()], "agents");
		return agent;
	}

	/** A bare id reads a node's output whole; a deeper address reads that value only. */
	private read(address: string, at: string): CheckedRead | undefined {
		const whole = this.outputs.get(address);
		if (whole !== undefined) return { address, type: whole };
		const type = this.typeOf(address, at);
		return type && { address, type };
	}

	private typeOf(address: string, at: string): ValueType | undefined {
		const root = address.split(".")[0] ?? "";
		if (this.flow.refused.has(root)) return undefined;
		if (this.ids.has(root) && !this.readable.has(root)) {
			this.faults.add("unknown-address", at, `\`${address}\`: \`${root}\` has not ended when this node runs, and a node reads only what already ended`);
			return undefined;
		}
		const typed = typeOfAddress(address, Object.fromEntries(this.readable) as Readable);
		if (typed.ok) return typed.type;
		for (const problem of typed.problems) this.faults.add(problem.code, at, problem.message);
		return undefined;
	}
}
