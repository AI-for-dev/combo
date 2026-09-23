/**
 * Reading a `loop`: its body, the condition that ends it converged, the cap
 * that ends it otherwise, and what one iteration hands the next.
 *
 * `until` and `max` are both required. A loop with no condition would repeat
 * a body a fixed number of times, which nothing needs, and one with no cap is
 * the unbounded cycle a flow cannot write.
 */

import { readLedger } from "./blocks.ts";
import type { LoopNode, NodeReading } from "./node.ts";
import { isRecord } from "./read-node.ts";
import { body, positive, text } from "./value.ts";

/** A `loop`, or `undefined` when a fault refused it. */
export function readLoop({ raw, id, at, faults, continueOnFail, sequence }: NodeReading): LoopNode | undefined {
	const until = text(raw.loop, `${at}.loop`, faults);
	if (raw.max === undefined) faults.add("missing-key", `${at}.max`, "a loop has `max:`, the most iterations it runs, so the worst case is known before the run");
	const max = raw.max === undefined ? undefined : positive(raw.max, `${at}.max`, faults);
	const giveUp = raw["give-up"] === undefined ? undefined : text(raw["give-up"], `${at}.give-up`, faults);
	const carry = raw.carry === undefined ? undefined : readCarry(raw.carry, `${at}.carry`, faults);
	const ledger = raw.ledger === undefined ? false : readLedger(raw.ledger, id, at, faults);
	if (raw.do === undefined) faults.add("missing-key", `${at}.do`, "a loop runs `do:`, its body, once per iteration");
	const nodes = body(sequence(raw.do, "do"), raw.do, `${at}.do`, faults, "a body runs at least one node");
	if (until === undefined || max === undefined || nodes === undefined) return undefined;
	if ((raw["give-up"] !== undefined && giveUp === undefined) || (raw.carry !== undefined && carry === undefined)) return undefined;
	return { kind: "loop", id, at, continueOnFail, until, max, giveUp, carry, ledger, nodes };
}

function readCarry(value: unknown, at: string, faults: NodeReading["faults"]): LoopNode["carry"] {
	if (!isRecord(value)) {
		faults.add("key-type", at, "takes `{ first: <address>, next: <address> }`");
		return undefined;
	}
	faults.keys(value, ["first", "next"], at, "keys of a carry");
	for (const key of ["first", "next"]) if (value[key] === undefined) faults.add("missing-key", `${at}.${key}`, "a carry has `first:`, read before the first iteration, and `next:`, read after each");
	const first = value.first === undefined ? undefined : text(value.first, `${at}.first`, faults);
	const next = value.next === undefined ? undefined : text(value.next, `${at}.next`, faults);
	return first === undefined || next === undefined ? undefined : { first, next };
}
