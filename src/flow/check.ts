/**
 * The flow stage of validation: a flow read against the catalogue it runs in,
 * before the first spawn.
 *
 * Every name is resolved here (the agents, the flows called, and the
 * addresses each node reads in its lexical scope) and every fault is
 * returned at once. What passes
 * becomes a `CheckedFlow`, the one thing the runner takes. What depends on the
 * project a run starts in (its working tree, its ports, whether somebody is
 * there) is the run stage's, and is not looked at here.
 */

import type { MarkdownFile } from "../markdown.ts";
import type { AgentNames } from "./agents.ts";
import { boundsOf } from "./bounds.ts";
import { checkAgent } from "./check-agent.ts";
import { checkAsk } from "./check-ask.ts";
import { Callees, checkCall } from "./check-call.ts";
import type { FlowCatalogue } from "./catalogue.ts";
import { checkChoice, checkMap, checkParallel } from "./check-blocks.ts";
import { checkLoop } from "./check-loop.ts";
import { checkCommit } from "./check-world.ts";
import { CHECK, COMMIT, type CheckedFlow, type CheckedNode, type CheckedRead } from "./checked.ts";
import { compileCondition, typeOfAddress, type Condition, type Readable } from "./condition/index.ts";
import { FaultList, type Fault } from "./fault.ts";
import type { FlowFile, ReadFlow } from "./file.ts";
import { checkShared } from "./memory.ts";
import { everyNode, type FlowNode } from "./node.ts";
import { Scope } from "./scope.ts";
import { sourcesOf } from "./sources.ts";
import type { ValueType } from "./type.ts";

/** A checked flow, or every fault that refused it. */
export type CheckFlow = { readonly ok: true; readonly flow: CheckedFlow } | { readonly ok: false; readonly faults: readonly Fault[] };

/**
 * The flow named `name` in `catalogue`, checked, with every flow it calls.
 *
 * A flow is found by its file name, so a file that does not parse is still
 * found, and reported as broken rather than unknown; its `name:` must say the
 * same. A flow calling a broken one is broken too.
 */
export function checkFlow(name: string, catalogue: FlowCatalogue): CheckFlow {
	const callees = new Callees(catalogue, checkFile);
	const source = callees.source(name);
	if (source !== undefined) return callees.check(source);
	const faults = new FaultList("");
	faults.unknown("unknown-flow", "", name, catalogue.flows.map((file) => file.name), "flows");
	return { ok: false, faults: faults.list };
}

/** One flow file checked, its calls resolved through `callees`. */
function checkFile(source: MarkdownFile, { flow, faults }: ReadFlow, callees: Callees): CheckFlow {
	if (flow === undefined) return { ok: false, faults: faults.list };
	const { name } = source;
	if (flow.name !== "" && flow.name !== name) faults.add("name-mismatch", "name", `\`${flow.name}\` is in \`${name}.md\`: a flow is found by its file name, so the two say the same`);
	const checker = new Checker(name, flow, callees, faults);
	const { nodes, last } = checker.sequence(flow.nodes, Scope.root(flow.input));
	checkShared(nodes, faults);
	faults.sort(flow.rank);
	if (faults.list.length > 0) return { ok: false, faults: faults.list };
	const { file, description, input, model, timeoutMs } = flow;
	const sources = sourcesOf(source, nodes, (agent) => callees.agents.skills(agent));
	const bounds = boundsOf(nodes, timeoutMs);
	return { ok: true, flow: { name, file, description, input, model, timeoutMs, nodes, output: last ?? { kind: "text" }, sources, bounds } as unknown as CheckedFlow };
}

/**
 * A sequence checked: its nodes, the type of each one's output by id, and the
 * type of what its last node outputs, which is what leaves a block.
 */
export type CheckedSequence = { readonly nodes: CheckedNode[]; readonly outputs: ReadonlyMap<string, ValueType>; readonly last?: ValueType };

/** A node checked: the node when it passed, and the type of its output either way, so what follows is checked too. */
export type CheckedOne = { readonly node?: CheckedNode; readonly output: ValueType };

/**
 * Resolves the nodes of one file. Each kind is checked in a `check-*.ts` of
 * its own, and the structural ones come back through
 * {@link Checker.sequence}.
 */
export class Checker {
	readonly faults: FaultList;
	/** The flow's name in the catalogue: what a call back to it is refused by. */
	private readonly name: string;
	private readonly flow: FlowFile;
	private readonly callees: Callees;
	readonly agents: AgentNames;
	/** Every id of the file, so an address to one not ended yet says so. */
	private readonly ids: ReadonlySet<string>;
	/** Ids nothing is reported about again: the file's refused nodes, and the calls whose callee is. */
	private readonly refused: Set<string>;

	constructor(name: string, flow: FlowFile, callees: Callees, faults: FaultList) {
		this.name = name;
		this.flow = flow;
		this.callees = callees;
		this.agents = callees.agents;
		this.faults = faults;
		this.ids = new Set([...everyNode(flow.nodes)].map((node) => node.id));
		this.refused = new Set(flow.refused);
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
		return new Checker(this.name, this.flow, this.callees, new FaultList(""));
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
		if (this.refused.has(root)) return undefined;
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
				return checkAgent(this, node, scope);
			case "choice":
				return checkChoice(this, node, scope);
			case "parallel":
				return checkParallel(this, node, scope);
			case "map":
				return checkMap(this, node, scope);
			case "loop":
				return checkLoop(this, node, scope);
			case "check":
				return { node, output: CHECK };
			case "commit":
				return { node: checkCommit(this, node, scope), output: COMMIT };
			case "ask":
				return checkAsk(this, node, scope);
			case "flow":
				return checkCall(this, node, scope);
		}
	}

	/** The flow `name`, called at `at`, checked whole; or `undefined` after saying why not. */
	callee(name: string, at: string): CheckedFlow | undefined {
		return this.callees.resolve(name, this.name, at, this.faults);
	}

	/** The prose of the `agent` node `id`, its `## <id>` section. */
	prose(id: string): string {
		return this.flow.sections.get(id) ?? "";
	}

	/** Marks the node `id` refused: what reads it is not reported again. */
	refuse(id: string): void {
		this.refused.add(id);
	}

	/** Whether `name` is the id of a node of this file. */
	isNode(name: string): boolean {
		return this.ids.has(name);
	}

	/** A bare id reads a node's output whole; a deeper address reads that value only. */
	read(address: string, at: string, scope: Scope): CheckedRead | undefined {
		const whole = scope.output(address);
		if (whole !== undefined) return { address, type: whole };
		const type = this.typeOf(address, at, scope);
		return type && { address, type };
	}

	/** Whether a condition names a refused node, so it is not reported again. */
	private refusedIn(source: string): boolean {
		return [...source.matchAll(/(?<![.\w])[A-Za-z_]\w*/g)].some(([word]) => this.refused.has(word));
	}
}
