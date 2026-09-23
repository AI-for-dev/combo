/**
 * One node of a flow, read from its YAML mapping: `id:`, exactly one kind key
 * holding its main argument, and that kind's options beside it.
 *
 * A node that is refused is read no further and left out of its sequence, and
 * its id is remembered so nothing that refers to it is reported again: one
 * mistake is one fault.
 */

import { isReserved } from "./condition/tokens.ts";
import type { FaultList } from "./fault.ts";
import { readSchema } from "./schema.ts";
import type { ValueType } from "./type.ts";
import { count, duration, oneOf, text, texts } from "./value.ts";

/**
 * The kinds of node, by the key that names each one: a node is `id:` plus
 * exactly one of these, holding its main argument. A `-from` key takes an
 * address where its twin takes a literal.
 */
export const KIND_KEYS = { agent: "agent", "agent-from": "agent" } as const;

/** Every key a node of each kind may carry. Anything else is refused. */
export const NODE_KEYS = {
	agent: ["id", "agent", "agent-from", "among", "memory", "reads", "output", "retry", "timeout", "on-fail"],
} as const;

/** A kind of node. */
export type NodeKind = keyof typeof NODE_KEYS;

/** One turn of an agent, named in the file or taken from a value within a closed set. */
export type AgentNode = {
	readonly kind: "agent";
	readonly id: string;
	/** The node's address through its enclosing nodes, without iterations. */
	readonly at: string;
	readonly agent: { readonly name: string } | { readonly from: string; readonly among: readonly string[] };
	/** The enclosing node, or `flow`, whose subagent this turn resumes. Absent: a fresh subagent. */
	readonly memory?: string;
	/** The addresses handed to the turn, in order. */
	readonly reads: readonly string[];
	/** The schema of a typed output. Absent: the output is the agent's text. */
	readonly output?: ValueType;
	readonly retry: number;
	readonly timeoutMs?: number;
	/** `on-fail: continue`: a failure stops here instead of travelling up. */
	readonly continueOnFail: boolean;
};

/** A node of any kind. */
export type FlowNode = AgentNode;

/**
 * Words an address uses. A node named so could not be told apart from them,
 * so none can be an id; a kind's name can, since a kind is always a key.
 */
const ADDRESS_WORDS = ["input", "item", "diff", "output", "ok", "error", "previous", "carry", "ledger"];

/** An id is read by addresses and conditions, so it is a CEL identifier. */
const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A sequence, read: its nodes, the ids refused, and every id in the order written. */
export type ReadNodes = { nodes: FlowNode[]; refused: Set<string>; ids: (string | undefined)[] };

/** A sequence of nodes at `at`, with the ids already taken in the file. */
export function readNodes(value: unknown, at: string, faults: FaultList, seen = new Set<string>()): ReadNodes {
	const nodes: FlowNode[] = [];
	const refused = new Set<string>();
	const ids: (string | undefined)[] = [];
	if (!Array.isArray(value) || value.length === 0) {
		if (value !== undefined) faults.add("key-type", at, "takes a list of nodes, at least one");
		return { nodes, refused, ids };
	}
	for (const [index, raw] of value.entries()) {
		const before = faults.list.length;
		const node = readNode(raw, `${at}[${index}]`, faults, seen);
		if (isRecord(raw)) {
			const keys = Object.keys(raw);
			faults.sort((fault) => rankOf(keys, fault.at.slice(fault.at.lastIndexOf(".") + 1)), before);
		}
		if (node !== undefined && faults.list.length === before) nodes.push(node);
		else if (isRecord(raw) && typeof raw.id === "string") refused.add(raw.id);
		ids.push(isRecord(raw) && typeof raw.id === "string" ? raw.id : undefined);
	}
	return { nodes, refused, ids };
}

/** Where `word` stands in `words`, the end when it is not there. */
export function rankOf(words: readonly (string | undefined)[], word: string): number {
	const index = words.indexOf(word);
	return index === -1 ? words.length : index;
}

function readNode(raw: unknown, place: string, faults: FaultList, seen: Set<string>): FlowNode | undefined {
	if (!isRecord(raw)) {
		faults.add("key-type", place, "a node is a mapping: `id:` and one kind key");
		return undefined;
	}
	const id = readId(raw.id, place, faults, seen);
	const at = id ?? place;
	const kinds = Object.keys(raw).filter((key) => key in KIND_KEYS) as (keyof typeof KIND_KEYS)[];
	if (kinds.length === 0) {
		faults.add("node-kind", at, `a node has one kind key: ${Object.keys(KIND_KEYS).join(", ")}`);
		return undefined;
	}
	const kind: NodeKind = KIND_KEYS[kinds[0] as keyof typeof KIND_KEYS];
	if (kinds.length > 1) {
		const twins = kinds.every((key) => KIND_KEYS[key] === kind);
		faults.add(twins ? "twin-keys" : "node-kind", at, `\`${kinds.join("` and `")}\`: ${twins ? "a literal or an address, not both" : "a node has one kind"}`);
		return undefined;
	}
	faults.keys(raw, NODE_KEYS[kind], at, `keys of an ${kind} node`);
	if (id === undefined) return undefined;
	return readAgent(raw, id, faults);
}

function readId(value: unknown, place: string, faults: FaultList, seen: Set<string>): string | undefined {
	if (value === undefined) {
		faults.add("missing-key", `${place}.id`, "every node has an `id:`");
		return undefined;
	}
	const id = text(value, `${place}.id`, faults);
	if (id === undefined) return undefined;
	if (!ID.test(id)) {
		faults.add("invalid-id", id, `\`${id}\`: an id is letters, digits and \`_\`, since addresses and conditions read it${id.includes("-") ? `; name it \`${id.replaceAll("-", "_")}\`` : ""}`);
	} else if (ADDRESS_WORDS.includes(id) || isReserved(id)) {
		faults.add("reserved-id", id, `\`${id}\` is a word ${ADDRESS_WORDS.includes(id) ? "an address" : "CEL"} reserves`);
	} else if (seen.has(id)) {
		faults.add("duplicate-id", id, `\`${id}\` names another node of this file: an id is unique in the whole file`);
	} else {
		seen.add(id);
		return id;
	}
	return undefined;
}

function readAgent(raw: Record<string, unknown>, id: string, faults: FaultList): AgentNode | undefined {
	const key = (name: string) => `${id}.${name}`;
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
	const output = raw.output === undefined ? undefined : schema(raw.output, key("output"), faults);
	const node = {
		kind: "agent",
		id,
		at: id,
		memory: raw.memory === undefined ? undefined : text(raw.memory, key("memory"), faults),
		reads: (raw.reads === undefined ? [] : texts(raw.reads, key("reads"), faults)) ?? [],
		output,
		retry: (raw.retry === undefined ? 0 : count(raw.retry, key("retry"), faults)) ?? 0,
		timeoutMs: raw.timeout === undefined ? undefined : duration(raw.timeout, key("timeout"), faults),
		continueOnFail: raw["on-fail"] !== undefined && oneOf(raw["on-fail"], ["continue"], key("on-fail"), faults) === "continue",
	} as const;
	return agent === undefined ? undefined : { ...node, agent };
}

function schema(written: unknown, at: string, faults: FaultList): ValueType | undefined {
	const result = readSchema(written);
	if (result.ok) return result.type;
	for (const problem of result.problems) faults.add(problem.code, problem.at === "" ? at : `${at}.${problem.at}`, problem.message);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
