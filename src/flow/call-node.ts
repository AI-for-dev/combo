/**
 * Reading a `flow` node: the name of the flow it calls, and the address of
 * what it hands in. Both are written in the file. The name is never taken
 * from a value, so the call graph is known before the run; and nothing is
 * passed in silence, so `input:` is required even when it is the caller's own.
 */

import type { CallNode, NodeReading } from "./node.ts";
import { text } from "./value.ts";

/** A `flow` node, or `undefined` when a fault refused it. */
export function readCall({ raw, id, at, faults, continueOnFail }: NodeReading): CallNode | undefined {
	const flow = text(raw.flow, `${at}.flow`, faults);
	if (raw.input === undefined) faults.add("missing-key", `${at}.input`, "a `flow` node hands its callee the value at an address, as `input: input`");
	const input = raw.input === undefined ? undefined : text(raw.input, `${at}.input`, faults);
	return flow === undefined || input === undefined ? undefined : { kind: "flow", id, at, continueOnFail, flow, input };
}
