/**
 * Reading an `agent` node's options: who runs the turn, what it reads, what it
 * outputs, and how its failures are handled.
 */

import type { AgentNode, NodeReading } from "./node.ts";
import { readSchema } from "./schema.ts";
import type { ValueType } from "./type.ts";
import { count, duration, text, texts } from "./value.ts";
import type { FaultList } from "./fault.ts";

/** An `agent` node, or `undefined` when a fault refused it. */
export function readAgent({ raw, id, at, faults, continueOnFail }: NodeReading): AgentNode | undefined {
	const key = (name: string) => `${at}.${name}`;
	let agent: AgentNode["agent"] | undefined;
	if (raw.agent !== undefined) {
		const name = text(raw.agent, key("agent"), faults);
		agent = name === undefined ? undefined : { name };
		if (raw.among !== undefined) faults.add("among-without-from", key("among"), "`among:` closes the set `agent-from:` picks in; with `agent:` there is nothing to pick");
	} else {
		const from = text(raw["agent-from"], key("agent-from"), faults);
		const among = raw.among === undefined ? undefined : texts(raw.among, key("among"), faults);
		if (raw.among === undefined) faults.add("missing-key", key("among"), "`agent-from:` needs `among:`, the agents it may pick, written in the file");
		agent = from === undefined || among === undefined ? undefined : { from, among };
	}
	const node = {
		kind: "agent",
		id,
		at,
		continueOnFail,
		memory: raw.memory === undefined ? undefined : text(raw.memory, key("memory"), faults),
		reads: (raw.reads === undefined ? [] : texts(raw.reads, key("reads"), faults)) ?? [],
		output: raw.output === undefined ? undefined : schema(raw.output, key("output"), faults),
		retry: (raw.retry === undefined ? 0 : count(raw.retry, key("retry"), faults)) ?? 0,
		timeoutMs: raw.timeout === undefined ? undefined : duration(raw.timeout, key("timeout"), faults),
	} as const;
	return agent === undefined ? undefined : { ...node, agent };
}

function schema(written: unknown, at: string, faults: FaultList): ValueType | undefined {
	const result = readSchema(written);
	if (result.ok) return result.type;
	for (const problem of result.problems) faults.add(problem.code, problem.at === "" ? at : `${at}.${problem.at}`, problem.message);
	return undefined;
}
