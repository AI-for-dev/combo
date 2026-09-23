/**
 * Checking the structural nodes that open branches, and the type of what each
 * hands on once its branches join.
 *
 * `choice` outputs `{ case, output? }`, `parallel` an object of its branches
 * by name, `map` a list of its items, and a failed branch stays in each, so a
 * block never drops what went wrong. Branches that run together and write
 * need copies of the repository; that rule is computed from the files alone,
 * the flows they call unrolled, and errs only on the safe side.
 */

import type { Agent } from "../agent.ts";
import type { CheckedOne, Checker } from "./check.ts";
import { caseNames, endedNode, LANDED, LEDGER, type CheckedNode } from "./checked.ts";
import type { ChoiceNode, MapNode, ParallelNode } from "./node.ts";
import type { Scope } from "./scope.ts";
import { sameType, showType, type Field, type ValueType } from "./type.ts";
import { unrolled } from "./unrolled.ts";

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
	const branches = node.branches.map(({ name, nodes }) => ({ name, ...checker.sequence(nodes, scope.inside(node.id, { copies: node.copies })) }));
	const fields = Object.fromEntries(branches.map(({ name, last }) => [name, { type: branchEnd(last as ValueType, node.copies), optional: false }]));
	const output: ValueType = { kind: "object", fields };
	if (!node.copies && node.branches.length > 1) needsCopies(checker, node.at, branches.map((b) => b.nodes), "`parallel` runs its branches at once");
	const { id, at, continueOnFail, copies, failFast } = node;
	return { output, node: { kind: "parallel", id, at, continueOnFail, copies, failFast, branches: branches.map(({ name, nodes }) => ({ name, nodes })) } };
}

/** A `map`: its list typed, its body in a scope that lends `item`, joined into a list in item order. */
export function checkMap(checker: Checker, node: MapNode, scope: Scope): CheckedOne {
	const item = "items" in node.over ? ({ kind: "string" } as const) : listElement(checker, node, node.over.from, scope);
	const inner = scope.inside(node.id, { ledger: node.ledger, copies: node.copies }).lend("item", item ?? { kind: "text" });
	if (node.ledger) inner.lend(node.id, { kind: "object", fields: { ledger: { type: LEDGER, optional: false } } });
	const body = checker.sequence(node.nodes, inner);
	const ended = branchEnd(body.last as ValueType, node.copies);
	const fields = { item: { type: item ?? { kind: "text" }, optional: false }, ...(ended.kind === "object" ? ended.fields : {}) };
	const output: ValueType = { kind: "list", of: { kind: "object", fields } };
	if (!node.copies && node.concurrency > 1) needsCopies(checker, node.at, [body.nodes], `\`concurrency: ${node.concurrency}\` runs items at once`, true);
	if (item === undefined) return { output };
	const { id, at, continueOnFail, over, max, concurrency, copies, failFast, ledger } = node;
	return { output, node: { kind: "map", id, at, continueOnFail, over, max, concurrency, copies, failFast, ledger, nodes: body.nodes } };
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
	for (const { node, at: where } of branches.flatMap((nodes) => [...unrolled(nodes)])) {
		if (node.kind === "commit") {
			// A commit in a copy would break its patch, so copies are no way out here.
			const fix = isMap ? "run the items one at a time with `concurrency: 1`, or commit after the block" : "commit after the block";
			checker.faults.add("copies-needed", `${at}.copies`, `${why}, and \`${where}\` commits: ${fix}`);
			return;
		}
		if (node.kind !== "agent") continue;
		const agents: Agent[] = "name" in node.agent ? [node.agent] : [...node.agent.among.values()];
		const writer = agents.find((agent) => agent.tools?.some((tool) => WRITING_TOOLS.includes(tool)));
		if (writer === undefined) continue;
		const tools = (writer.tools ?? []).filter((tool) => WRITING_TOOLS.includes(tool)).join(", ");
		const fix = isMap ? "`copies: true`, or `concurrency: 1`" : "`copies: true`";
		checker.faults.add("copies-needed", `${at}.copies`, `${why}, and \`${where}\` writes (\`${writer.name}\` has ${tools}): give each branch its own copy with ${fix}`);
		return;
	}
}

/** A branch's entry in its block's output: as it ended, and with copies, whether its patch landed. */
function branchEnd(last: ValueType, copies: boolean): ValueType {
	const ended = endedNode(last);
	return copies && ended.kind === "object" ? { kind: "object", fields: { ...ended.fields, ...LANDED } } : ended;
}

/** The type every sequence that ran a node ends on, when there is exactly one. */
function common(lasts: readonly (ValueType | undefined)[]): ValueType | undefined {
	const present = lasts.filter((last) => last !== undefined);
	const first = present[0];
	return first !== undefined && present.every((last) => sameType(last, first)) ? first : undefined;
}
