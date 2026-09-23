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
import { AgentNames } from "./agents.ts";
import type { FlowCatalogue } from "./catalogue.ts";
import { checkChoice, checkMap, checkParallel } from "./check-blocks.ts";
import { checkLoop } from "./check-loop.ts";
import { VERDICT, type CheckedAgentNode, type CheckedFlow, type CheckedNode, type CheckedRead } from "./checked.ts";
import { compileCondition, typeOfAddress, type Condition, type Readable } from "./condition/index.ts";
import { FaultList, type Fault } from "./fault.ts";
import { readFlow, type FlowFile } from "./file.ts";
import { everyNode, type AgentNode, type FlowNode } from "./node.ts";
import { Scope } from "./scope.ts";
import { showType, type ValueType } from "./type.ts";

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
	const checker = new Checker(flow, new AgentNames(catalogue), faults);
	const { nodes } = checker.sequence(flow.nodes, Scope.root(flow.input));
	faults.sort(flow.rank);
	if (faults.list.length > 0) return { ok: false, faults: faults.list };
	const { file, description, input, model, timeoutMs } = flow;
	return { ok: true, flow: { name, file, description, input, model, timeoutMs, nodes } as unknown as CheckedFlow };
}

/**
 * A sequence checked: its nodes, the type of each one's output by id, and the
 * type of what its last node outputs, which is what leaves a block.
 */
export type CheckedSequence = { readonly nodes: CheckedNode[]; readonly outputs: ReadonlyMap<string, ValueType>; readonly last?: ValueType };

/** A node checked: the node when it passed, and the type of its output either way, so what follows is checked too. */
export type CheckedOne = { readonly node?: CheckedNode; readonly output: ValueType };

/**
 * Resolves the nodes of one file. The structural kinds live in
 * `check-blocks.ts` and `check-loop.ts`, and come back through
 * {@link Checker.sequence}.
 */
export class Checker {
	readonly faults: FaultList;
	private readonly flow: FlowFile;
	private readonly agents: AgentNames;
	/** Every id of the file, so an address to one not ended yet says so. */
	private readonly ids: ReadonlySet<string>;

	constructor(flow: FlowFile, agents: AgentNames, faults: FaultList) {
		this.flow = flow;
		this.agents = agents;
		this.faults = faults;
		this.ids = new Set([...everyNode(flow.nodes)].map((node) => node.id));
	}

	/** `nodes` in `scope`, each ended node readable by the ones after it. */
	sequence(nodes: readonly FlowNode[], scope: Scope): CheckedSequence {
		const checked: CheckedNode[] = [];
		const outputs = new Map<string, ValueType>();
		let last: ValueType | undefined;
		for (const node of nodes) {
			const before = this.faults.list.length;
			const one = this.node(node, scope);
			if (one.node !== undefined && this.faults.list.length === before) checked.push(one.node);
			scope.end(node.id, one.output);
			outputs.set(node.id, one.output);
			last = one.output;
		}
		return { nodes: checked, outputs, last };
	}

	/**
	 * The same checker with its faults thrown away: what a loop's body outputs
	 * is needed to type its `previous` before the body is checked for real.
	 */
	quietly(): Checker {
		return new Checker(this.flow, this.agents, new FaultList(""));
	}

	/** The condition `source`, written at `at`, compiled against what `scope` can read. */
	condition(source: string, at: string, scope: Scope): Condition | undefined {
		if (this.refusedIn(source)) return undefined;
		const compiled = compileCondition(source, scope.readable() as Readable);
		if (compiled.ok) return compiled.condition;
		for (const problem of compiled.problems) this.faults.add(problem.code, at, problem.message);
		return undefined;
	}

	/** The type `address` names in `scope`, or `undefined` after saying why. */
	typeOf(address: string, at: string, scope: Scope): ValueType | undefined {
		const root = address.split(".")[0] ?? "";
		if (this.flow.refused.has(root)) return undefined;
		if (this.ids.has(root) && !scope.has(root)) {
			this.faults.add("unknown-address", at, `\`${address}\`: \`${root}\` has not ended when this node runs, or ends in a block this node is not in`);
			return undefined;
		}
		const typed = typeOfAddress(address, scope.readable() as Readable);
		if (typed.ok) return typed.type;
		for (const problem of typed.problems) this.faults.add(problem.code, at, problem.message);
		return undefined;
	}

	private node(node: FlowNode, scope: Scope): CheckedOne {
		switch (node.kind) {
			case "agent":
				return { node: this.agentNode(node, scope), output: node.verdict !== undefined ? VERDICT : (node.output ?? { kind: "text" }) };
			case "choice":
				return checkChoice(this, node, scope);
			case "parallel":
				return checkParallel(this, node, scope);
			case "map":
				return checkMap(this, node, scope);
			case "loop":
				return checkLoop(this, node, scope);
		}
	}

	private agentNode(node: AgentNode, scope: Scope): CheckedAgentNode | undefined {
		const agent = "name" in node.agent ? this.agents.resolve(node.agent.name, `${node.at}.agent`, this.faults) : this.picked(node, node.agent.from, node.agent.among, scope);
		if (node.memory !== undefined && node.memory !== "flow" && !scope.encloses(node.memory)) {
			this.faults.add("unknown-scope", `${node.at}.memory`, `\`${node.memory}\` is not a node this one is in; \`memory:\` names one, or \`flow\` for the whole file`);
		}
		if (node.verdict !== undefined && !scope.keepsLedger(node.verdict)) {
			this.faults.add("unknown-scope", `${node.at}.verdict`, `\`${node.verdict}\` is not a node this one is in with a \`ledger:\`; \`verdict:\` names the one whose ledger it writes to`);
		}
		const reads = node.reads.map((address) => this.read(address, `${node.at}.reads`, scope)).filter((read) => read !== undefined);
		if (agent === undefined) return undefined;
		const prose = this.flow.sections.get(node.id) ?? "";
		const { id, at, memory, output, verdict, retry, timeoutMs, continueOnFail } = node;
		return { kind: "agent", id, at, agent, prose, memory, reads, output, verdict, retry, timeoutMs, continueOnFail };
	}

	/** `agent-from:` reads an enum, and `among:` names exactly its values, each an agent. */
	private picked(node: AgentNode, from: string, among: readonly string[], scope: Scope): CheckedAgentNode["agent"] | undefined {
		const at = `${node.at}.agent-from`;
		const type = this.typeOf(from, at, scope);
		const agents = new Map<string, Agent>();
		for (const name of among) {
			const agent = this.agents.resolve(name, `${node.at}.among`, this.faults);
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

	/** A bare id reads a node's output whole; a deeper address reads that value only. */
	private read(address: string, at: string, scope: Scope): CheckedRead | undefined {
		const whole = scope.output(address);
		if (whole !== undefined) return { address, type: whole };
		const type = this.typeOf(address, at, scope);
		return type && { address, type };
	}

	/** Whether a condition names a refused node, so it is not reported again. */
	private refusedIn(source: string): boolean {
		return [...source.matchAll(/(?<![.\w])[A-Za-z_]\w*/g)].some(([word]) => this.flow.refused.has(word));
	}
}
