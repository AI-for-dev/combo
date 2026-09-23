/**
 * Reading the structural nodes that open branches: `choice`, `parallel` and
 * `map`. Each holds sequences of its own, and the end of the block is where
 * they join.
 */

import type { ChoiceNode, FlowNode, MapNode, NodeReading, ParallelNode } from "./node.ts";
import { isRecord } from "./read-node.ts";
import { count, flag, text, texts } from "./value.ts";

/** A branch name is read as a field of the block's output, so it is a CEL identifier. */
const BRANCH = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A `choice`: ordered cases, each `{ when, do }`, and a `default:` that is always written. */
export function readChoice({ raw, id, at, faults, continueOnFail, sequence }: NodeReading): ChoiceNode | undefined {
	const written = raw.choice;
	if (!Array.isArray(written) || written.length === 0) {
		faults.add("key-type", `${at}.choice`, "takes a list of cases, each `{ when: <condition>, do: [nodes] }`");
		return undefined;
	}
	const cases: { when: string; nodes: FlowNode[] }[] = [];
	for (const [index, one] of written.entries()) {
		const place = `${at}.choice[${index}]`;
		if (!isRecord(one)) {
			faults.add("key-type", place, "a case is `{ when: <condition>, do: [nodes] }`");
			continue;
		}
		faults.keys(one, ["when", "do"], place, "keys of a case");
		const when = text(one.when, `${place}.when`, faults);
		const nodes = nonEmpty(sequence(one.do, `choice[${index}].do`), one.do, `${place}.do`, faults, "a case runs at least one node; what runs when nothing matches is `default:`");
		if (when !== undefined && nodes !== undefined) cases.push({ when, nodes });
	}
	if (raw.default === undefined) faults.add("missing-key", `${at}.default`, "a choice always has a `default:`, `[]` when nothing runs");
	const otherwise = sequence(raw.default, "default");
	return cases.length === written.length ? { kind: "choice", id, at, continueOnFail, cases, otherwise } : undefined;
}

/** A `parallel`: named branches, at least two, each a sequence. */
export function readParallel({ raw, id, at, faults, continueOnFail, sequence }: NodeReading): ParallelNode | undefined {
	const written = raw.parallel;
	if (!isRecord(written) || Object.keys(written).length < 2) {
		faults.add("key-type", `${at}.parallel`, "takes named branches, at least two: `{ <name>: [nodes], ... }`");
		return undefined;
	}
	const branches: { name: string; nodes: FlowNode[] }[] = [];
	for (const [name, value] of Object.entries(written)) {
		const place = `${at}.parallel.${name}`;
		if (!BRANCH.test(name)) faults.add("key-type", place, `\`${name}\`: a branch name is letters, digits and \`_\`, since the block's output is read by it`);
		const nodes = nonEmpty(sequence(value, `parallel.${name}`), value, place, faults, "a branch runs at least one node");
		if (nodes !== undefined) branches.push({ name, nodes });
	}
	const copies = raw.copies === undefined ? false : flag(raw.copies, `${at}.copies`, faults);
	const failFast = raw["fail-fast"] === undefined ? false : flag(raw["fail-fast"], `${at}.fail-fast`, faults);
	if (branches.length !== Object.keys(written).length || copies === undefined || failFast === undefined) return undefined;
	return { kind: "parallel", id, at, continueOnFail, branches, copies, failFast };
}

/** A `map`: a literal list with `map:`, or an address with `map-from:` and a required `max:`. */
export function readMap({ raw, id, at, faults, continueOnFail, sequence }: NodeReading): MapNode | undefined {
	let over: MapNode["over"] | undefined;
	let max: number | undefined;
	if (raw.map !== undefined) {
		const items = texts(raw.map, `${at}.map`, faults);
		over = items === undefined ? undefined : { items };
		if (raw.max !== undefined) faults.add("unknown-key", `${at}.max`, "a literal list is its own bound: `max:` goes with `map-from:`");
	} else {
		const from = text(raw["map-from"], `${at}.map-from`, faults);
		over = from === undefined ? undefined : { from };
		if (raw.max === undefined) faults.add("missing-key", `${at}.max`, "`map-from:` needs `max:`, the longest list it takes, so the worst case is known before the run");
		else max = positive(raw.max, `${at}.max`, faults);
	}
	const concurrency = raw.concurrency === undefined ? 1 : positive(raw.concurrency, `${at}.concurrency`, faults);
	const copies = raw.copies === undefined ? false : flag(raw.copies, `${at}.copies`, faults);
	const failFast = raw["fail-fast"] === undefined ? false : flag(raw["fail-fast"], `${at}.fail-fast`, faults);
	if (raw.do === undefined) faults.add("missing-key", `${at}.do`, "a map runs `do:`, its body, once per item");
	const nodes = nonEmpty(sequence(raw.do, "do"), raw.do, `${at}.do`, faults, "a body runs at least one node");
	if (over === undefined || concurrency === undefined || copies === undefined || failFast === undefined || nodes === undefined) return undefined;
	if (raw["map-from"] !== undefined && max === undefined) return undefined;
	return { kind: "map", id, at, continueOnFail, over, max, concurrency, copies, failFast, nodes };
}

/** A sequence that was written with at least one node, or `undefined`, saying why when it was written empty. */
function nonEmpty(nodes: FlowNode[], written: unknown, at: string, faults: NodeReading["faults"], why: string): FlowNode[] | undefined {
	if (Array.isArray(written) && written.length === 0) faults.add("key-type", at, why);
	return Array.isArray(written) && written.length > 0 ? nodes : undefined;
}

function positive(value: unknown, at: string, faults: NodeReading["faults"]): number | undefined {
	const n = count(value, at, faults);
	if (n !== 0) return n;
	faults.add("key-type", at, "takes a whole number, one or more");
	return undefined;
}
