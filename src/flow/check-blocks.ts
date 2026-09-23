/**
 * Checking the structural nodes that open branches, and the type of what each
 * hands on once its branches join.
 *
 * `choice` outputs `{ case, output? }`, `parallel` an object of its branches
 * by name, `map` a list of its items, and a failed branch stays in each, so a
 * block never drops what went wrong. Branches that run together and write
 * need copies of the repository; that rule is computed from the files alone,
 * and errs only on the safe side.
 */

import type { Agent } from "../agent.ts";
import type { CheckedOne, Checker } from "./check.ts";
import { caseNames, endedNode, type CheckedNode } from "./checked.ts";
import type { ChoiceNode, MapNode, ParallelNode } from "./node.ts";
import { everyNode } from "./node.ts";
import type { Scope } from "./scope.ts";
import { sameType, showType, type Field, type ValueType } from "./type.ts";

/** Tools that change the working tree, or can: a delegating agent's children may be any agent. */
const WRITING_TOOLS = ["write", "edit", "bash", "subagent"];

/** A `choice`: each case's condition in the choice's scope, each case's nodes in a scope of their own. */
export function checkChoice(checker: Checker, node: ChoiceNode, scope: Scope): CheckedOne {
	const cases = node.cases.map((one, index) => ({
		when: checker.condition(one.when, `${node.at}.choice[${index}].when`, scope),
		...checker.sequence(one.nodes, scope.inside(node.id)),
	}));
	const otherwise = checker.sequence(node.otherwise, scope.inside(node.id));
	// The case that runs is only known at run time, so `output` is typed when
	// every case that runs a node ends on one type, and optional when one runs none.
	const lasts = [...cases, otherwise].map((one) => one.last);
	const shared = common(lasts);
	const fields: Record<string, Field> = { case: { type: { kind: "enum", values: caseNames(cases.length) }, optional: false } };
	if (shared !== undefined) fields.output = { type: shared, optional: lasts.includes(undefined) };
	const output: ValueType = { kind: "object", fields };
	if (cases.some((one) => one.when === undefined)) return { output };
	const checked = cases.map(({ when, nodes }) => ({ when: when as NonNullable<typeof when>, nodes }));
	return { output, node: { kind: "choice", id: node.id, at: node.at, continueOnFail: node.continueOnFail, cases: checked, otherwise: otherwise.nodes } };
}

/** A `parallel`: each branch in a scope of its own, joined into an object by branch name. */
export function checkParallel(checker: Checker, node: ParallelNode, scope: Scope): CheckedOne {
	const branches = node.branches.map(({ name, nodes }) => ({ name, ...checker.sequence(nodes, scope.inside(node.id)) }));
	const fields = Object.fromEntries(branches.map(({ name, last }) => [name, { type: endedNode(last as ValueType), optional: false }]));
	const output: ValueType = { kind: "object", fields };
	if (!node.copies && node.branches.length > 1) needsCopies(checker, node.at, branches.map((b) => b.nodes), "`parallel` runs its branches at once");
	const { id, at, continueOnFail, copies, failFast } = node;
	return { output, node: { kind: "parallel", id, at, continueOnFail, copies, failFast, branches: branches.map(({ name, nodes }) => ({ name, nodes })) } };
}

/** A `map`: its list typed, its body in a scope that lends `item`, joined into a list in item order. */
export function checkMap(checker: Checker, node: MapNode, scope: Scope): CheckedOne {
	const item = "items" in node.over ? ({ kind: "string" } as const) : listElement(checker, node, node.over.from, scope);
	const body = checker.sequence(node.nodes, scope.inside(node.id).lend("item", item ?? { kind: "text" }));
	const ended = endedNode(body.last as ValueType);
	const fields = { item: { type: item ?? { kind: "text" }, optional: false }, ...(ended.kind === "object" ? ended.fields : {}) };
	const output: ValueType = { kind: "list", of: { kind: "object", fields } };
	if (!node.copies && node.concurrency > 1) needsCopies(checker, node.at, [body.nodes], `\`concurrency: ${node.concurrency}\` runs items at once`, true);
	if (item === undefined) return { output };
	const { id, at, continueOnFail, over, max, concurrency, copies, failFast } = node;
	return { output, node: { kind: "map", id, at, continueOnFail, over, max, concurrency, copies, failFast, nodes: body.nodes } };
}

function listElement(checker: Checker, node: MapNode, from: string, scope: Scope): ValueType | undefined {
	const type = checker.typeOf(from, `${node.at}.map-from`, scope);
	if (type === undefined || type.kind === "list") return type?.kind === "list" ? type.of : undefined;
	checker.faults.add("key-type", `${node.at}.map-from`, `\`${from}\` is ${showType(type)}; \`map-from:\` reads a list`);
	return undefined;
}

/**
 * Refuses branches that run together without copies as soon as one of them
 * writes: a branch that only reads, beside one that writes, reads a tree that
 * moves under it.
 */
function needsCopies(checker: Checker, at: string, branches: readonly (readonly CheckedNode[])[], why: string, isMap = false): void {
	for (const node of branches.flatMap((nodes) => [...everyNode(nodes)])) {
		if (node.kind !== "agent") continue;
		const agents: Agent[] = "name" in node.agent ? [node.agent] : [...node.agent.among.values()];
		const writer = agents.find((agent) => agent.tools?.some((tool) => WRITING_TOOLS.includes(tool)));
		if (writer === undefined) continue;
		const tools = (writer.tools ?? []).filter((tool) => WRITING_TOOLS.includes(tool)).join(", ");
		const fix = isMap ? "`copies: true`, or `concurrency: 1`" : "`copies: true`";
		checker.faults.add("copies-needed", `${at}.copies`, `${why}, and \`${node.at}\` writes (\`${writer.name}\` has ${tools}): give each branch its own copy with ${fix}`);
		return;
	}
}

/** The type every sequence that ran a node ends on, when there is exactly one. */
function common(lasts: readonly (ValueType | undefined)[]): ValueType | undefined {
	const present = lasts.filter((last) => last !== undefined);
	const first = present[0];
	return first !== undefined && present.every((last) => sameType(last, first)) ? first : undefined;
}
