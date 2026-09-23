/**
 * Checking a `loop`, and what one iteration can read of the loop itself: the
 * previous iteration, the carried value, the ledger.
 *
 * Its body reads `<loop>.previous.<node>`, the output of a body node one
 * iteration back, so the body's output types are needed before the body is
 * checked. A first, silent pass gives them; outputs never depend on reads, so
 * that pass cannot disagree with the one that reports.
 */

import type { CheckedOne, Checker } from "./check.ts";
import { endedNode, LEDGER, STOPS } from "./checked.ts";
import type { LoopNode } from "./node.ts";
import type { Scope } from "./scope.ts";
import { showType, type Field, type ValueType } from "./type.ts";

/** A `loop`: its body in a scope of its own, `until` and `give-up` read once the body ended. */
export function checkLoop(checker: Checker, node: LoopNode, scope: Scope): CheckedOne {
	const first = node.carry && checker.typeOf(node.carry.first, `${node.at}.carry.first`, scope);
	const inner = (previous: ValueType | undefined, carry: ValueType | undefined) =>
		scope.inside(node.id, node.ledger).lend(node.id, own(previous, carry, node.ledger));

	const draftScope = inner(undefined, first);
	const draft = checker.quietly().sequence(node.nodes, draftScope);
	const drafted = node.carry && checker.quietly().typeOf(node.carry.next, "", draftScope);
	// A carry that shares nothing is reported once, below; inside the body it reads as its first value.
	const carry = (first && drafted && shared(first, drafted)) || first;

	const bodyScope = inner(byId(draft.outputs), carry);
	const body = checker.sequence(node.nodes, bodyScope);
	const until = checker.condition(node.until, `${node.at}.loop`, bodyScope);
	const giveUp = node.giveUp === undefined ? undefined : checker.condition(node.giveUp, `${node.at}.give-up`, bodyScope);
	if (node.carry && first) {
		const next = checker.typeOf(node.carry.next, `${node.at}.carry.next`, bodyScope);
		if (next && shared(first, next) === undefined) {
			checker.faults.add("carry-mismatch", `${node.at}.carry`, `\`${node.carry.first}\` is ${showType(first)} and \`${node.carry.next}\` ${showType(next)}: they share no field, so nothing can be carried`);
		}
	}

	const output: ValueType = {
		kind: "object",
		fields: {
			converged: { type: { kind: "boolean" }, optional: false },
			stop: { type: { kind: "enum", values: STOPS }, optional: false },
			iterations: { type: { kind: "number" }, optional: false },
			last: { type: byId(body.outputs), optional: false },
		},
	};
	if (until === undefined || (node.giveUp !== undefined && giveUp === undefined)) return { output };
	const { id, at, continueOnFail, max, ledger } = node;
	return { output, node: { kind: "loop", id, at, continueOnFail, until, max, giveUp, carry: node.carry, ledger, nodes: body.nodes } };
}

/** What the loop's own id reads inside its body. `previous` is absent on the first iteration. */
function own(previous: ValueType | undefined, carry: ValueType | undefined, ledger: boolean): ValueType {
	const fields: Record<string, Field> = {};
	if (previous !== undefined) fields.previous = { type: previous, optional: true };
	if (carry !== undefined) fields.carry = { type: carry, optional: false };
	if (ledger) fields.ledger = { type: LEDGER, optional: false };
	return { kind: "object", fields };
}

/** The body's nodes as they ended, by id: what `previous` and `last` read. */
function byId(outputs: ReadonlyMap<string, ValueType>): ValueType {
	return { kind: "object", fields: Object.fromEntries([...outputs].map(([id, output]) => [id, { type: endedNode(output), optional: false }])) };
}

/**
 * What two types have in common: the fields both sides have with the same
 * name and type, so a carry read on any iteration reads what is there.
 */
export function shared(a: ValueType, b: ValueType): ValueType | undefined {
	if (a.kind === "list" && b.kind === "list") {
		const of = shared(a.of, b.of);
		return of && { kind: "list", of };
	}
	if (a.kind === "object" && b.kind === "object") {
		const fields: Record<string, Field> = {};
		for (const [name, field] of Object.entries(a.fields)) {
			const other = b.fields[name];
			const type = other && shared(field.type, other.type);
			if (type !== undefined && other !== undefined) fields[name] = { type, optional: field.optional || other.optional };
		}
		return Object.keys(fields).length > 0 ? { kind: "object", fields } : undefined;
	}
	if (a.kind === "enum" && b.kind === "enum") return a.values.length === b.values.length && a.values.every((v) => b.values.includes(v)) ? a : undefined;
	return a.kind === b.kind && a.kind !== "text" ? a : undefined;
}
