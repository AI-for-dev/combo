/**
 * Checking a `flow` node: its callee resolved in the run's catalogue and
 * checked whole, the call graph held free of cycles, and what crosses the
 * boundary, `input` in and the callee's last root node's output back.
 *
 * Nothing else crosses it: a callee sees none of its caller's scopes, ledgers
 * or prose, so it is checked on its own, once however many nodes call it,
 * and every flow is valid on its own. The world does cross. What a callee
 * does to the tree counts where the call stands, so a commit it holds is
 * refused inside a `copies: true` block, the fault naming the call path.
 */

import type { MarkdownFile } from "../markdown.ts";
import { AgentNames } from "./agents.ts";
import type { FlowCatalogue } from "./catalogue.ts";
import type { CheckedOne, Checker, CheckFlow } from "./check.ts";
import type { CheckedCallNode, CheckedFlow } from "./checked.ts";
import type { FaultList } from "./fault.ts";
import { readFlow, type ReadFlow } from "./file.ts";
import { everyNode, type CallNode } from "./node.ts";
import type { Scope } from "./scope.ts";
import { sameType, showType, type ValueType } from "./type.ts";
import { unrolled } from "./unrolled.ts";

/** How a flow file is checked, given the callees its calls resolve through. */
export type CheckFile = (source: MarkdownFile, read: ReadFlow, callees: Callees) => CheckFlow;

/**
 * The flows of one catalogue, each read once and checked once, whoever calls
 * it: the root of a check and every flow it reaches share one.
 */
export class Callees {
	readonly agents: AgentNames;
	private readonly catalogue: FlowCatalogue;
	private readonly checkFile: CheckFile;
	private readonly read = new Map<string, ReadFlow>();
	private readonly checked = new Map<string, CheckFlow>();

	constructor(catalogue: FlowCatalogue, checkFile: CheckFile) {
		this.catalogue = catalogue;
		this.checkFile = checkFile;
		this.agents = new AgentNames(catalogue);
	}

	/** The flow file named `name`, when the catalogue has one. */
	source(name: string): MarkdownFile | undefined {
		return this.catalogue.flows.find((file) => file.name === name);
	}

	/** The flow in `source` checked, the first time it is asked for. */
	check(source: MarkdownFile): CheckFlow {
		let result = this.checked.get(source.name);
		if (result === undefined) {
			result = this.checkFile(source, this.readOf(source), this);
			this.checked.set(source.name, result);
		}
		return result;
	}

	/**
	 * The flow `name`, called at `at` by the flow `caller`, checked; or
	 * `undefined` after saying why not. A call that leads back to its caller,
	 * however far down, is refused before the callee is checked, so the check
	 * itself always ends.
	 */
	resolve(name: string, caller: string, at: string, faults: FaultList): CheckedFlow | undefined {
		const source = this.source(name);
		if (source === undefined) {
			faults.unknown("unknown-flow", at, name, this.catalogue.flows.map((file) => file.name), "flows");
			return undefined;
		}
		const cycle = this.path(name, caller, new Set());
		if (cycle !== undefined) {
			faults.add("call-cycle", at, `${[caller, ...cycle].map((one) => `\`${one}\``).join(" -> ")}: a flow that calls itself would never end`);
			return undefined;
		}
		const result = this.check(source);
		if (result.ok) return result.flow;
		const [first] = result.faults;
		const more = result.faults.length - 1;
		const where = first?.at === "" ? "" : ` at \`${first?.at}\``;
		faults.add("broken-flow", at, `\`${name}\` is ${source.filePath}, which is refused${where}: ${first?.message}${more > 0 ? ` (and ${more} more)` : ""}`);
		return undefined;
	}

	/** The call path from `from` to `to`, `[from, ..., to]`, when `from` reaches it through the calls written in the files. */
	private path(from: string, to: string, seen: Set<string>): string[] | undefined {
		if (from === to) return [from];
		if (seen.has(from)) return undefined;
		seen.add(from);
		for (const next of this.callsOf(from)) {
			const rest = this.path(next, to, seen);
			if (rest !== undefined) return [from, ...rest];
		}
		return undefined;
	}

	/** The names the flow `name` calls, behind a `choice` or not: a cycle is refused whether it would be taken or not. */
	private callsOf(name: string): string[] {
		const source = this.source(name);
		const nodes = source === undefined ? [] : (this.readOf(source).flow?.nodes ?? []);
		return [...everyNode(nodes)].flatMap((node) => (node.kind === "flow" ? [node.flow] : []));
	}

	private readOf(source: MarkdownFile): ReadFlow {
		let read = this.read.get(source.name);
		if (read === undefined) {
			read = readFlow(source.content, source.filePath);
			this.read.set(source.name, read);
		}
		return read;
	}
}

/** A `flow` node: its callee, what it hands in, and what the callee does that its place refuses. */
export function checkCall(checker: Checker, node: CallNode, scope: Scope): CheckedOne {
	const { faults } = checker;
	const callee = checker.callee(node.flow, `${node.at}.flow`);
	const input = checker.read(node.input, `${node.at}.input`, scope);
	if (callee === undefined) {
		// What it outputs is unknown: nothing that reads it is reported again.
		checker.refuse(node.id);
		return { output: { kind: "text" } };
	}
	const before = faults.list.length;
	if (input !== undefined && !takes(callee.input, input.type)) {
		faults.add("flow-input-mismatch", `${node.at}.input`, `\`${node.input}\` is ${showType(input.type)}, and \`${node.flow}\` takes ${showType(callee.input)}`);
	}
	if (scope.inCopies()) {
		for (const inner of unrolled(callee.nodes, node.at)) {
			if (inner.node.kind === "commit") faults.add("commit-in-copies", `${inner.at}.commit`, `\`${node.flow}\` commits, and a commit in a branch's copy would break the patch that brings the branch home: call it after the block`);
		}
	}
	if (input === undefined || faults.list.length > before) return { output: callee.output };
	const { id, at, continueOnFail } = node;
	return { output: callee.output, node: { kind: "flow", id, at, continueOnFail, callee, input } satisfies CheckedCallNode };
}

/** Whether a flow whose `input:` is `input` takes a value of type `given`: a text input takes any, a typed one as JSON. */
function takes(input: ValueType, given: ValueType): boolean {
	return input.kind === "string" || sameType(input, given);
}
