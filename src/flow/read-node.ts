/**
 * Reading one node of a flow from its YAML mapping, and the sequences nested
 * in it.
 *
 * A node that is refused is read no further and left out of its sequence,
 * and its id is remembered so nothing that refers to it is reported again:
 * one mistake is one fault. The faults of a node come back in the order its
 * keys are written, whatever order they were checked in.
 */

import { isReserved } from "./condition/tokens.ts";
import type { Fault, FaultList } from "./fault.ts";
import { KIND_KEYS, NODE_KEYS, RETRY_REFUSED, type FlowNode, type KindReader, type NodeKind, type ReadContext } from "./node.ts";
import { text } from "./value.ts";

/**
 * Words an address uses. A node named so could not be told apart from them,
 * so none can be an id; a kind's name can, since a kind is always a key.
 */
const ADDRESS_WORDS = ["input", "item", "diff", "output", "ok", "error", "previous", "carry", "ledger"];

/** An id is read by addresses and conditions, so it is a CEL identifier. */
const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The keys that hold nested sequences: a fault inside one is ranked with it. */
const BODY_KEYS = ["choice", "parallel", "do", "default"];

/**
 * A sequence of nodes under `key`, inside the node at `path` (`""` at the
 * root), read by the readers of `kinds`.
 */
export function readSequence(value: unknown, key: string, path: string, context: ReadContext, kinds: Readonly<Record<NodeKind, KindReader>>): FlowNode[] {
	const { faults } = context;
	const nodes: FlowNode[] = [];
	if (!Array.isArray(value)) {
		if (value !== undefined) faults.add("key-type", key, "takes a list of nodes");
		return nodes;
	}
	for (const [index, raw] of value.entries()) {
		const before = faults.list.length;
		const seen = new Set(context.seen);
		const place = `${key}[${index}]`;
		const node = readNode(raw, place, path, context, kinds);
		if (isRecord(raw)) faults.sort(rankIn(Object.keys(raw), node?.at ?? place), before);
		// A fault inside a nested node refuses that node, not the block around it.
		const own = faults.list.slice(before).some((fault) => node === undefined || !fault.at.startsWith(`${node.at}/`));
		if (node !== undefined && !own) {
			nodes.push(node);
			continue;
		}
		// What was read under a refused node goes with it, and the blocks around
		// it hand on an output nobody can type: none of them is reported again.
		for (const id of context.seen) if (!seen.has(id)) context.refused.add(id);
		if (isRecord(raw) && typeof raw.id === "string") context.refused.add(raw.id);
		for (const id of path.split("/")) if (id !== "") context.refused.add(id);
	}
	return nodes;
}

function readNode(raw: unknown, place: string, path: string, context: ReadContext, kinds: Readonly<Record<NodeKind, KindReader>>): FlowNode | undefined {
	const { faults } = context;
	if (!isRecord(raw)) {
		faults.add("key-type", place, "a node is a mapping: `id:` and one kind key");
		return undefined;
	}
	const id = readId(raw.id, place, path, context);
	const at = id === undefined ? place : under(path, id);
	const found = Object.keys(raw).filter((key) => key in KIND_KEYS) as (keyof typeof KIND_KEYS)[];
	if (found.length === 0) {
		faults.add("node-kind", at, `a node has one kind key: ${Object.keys(KIND_KEYS).join(", ")}`);
		return undefined;
	}
	const kind: NodeKind = KIND_KEYS[found[0] as keyof typeof KIND_KEYS];
	if (found.length > 1) {
		const twins = found.every((key) => KIND_KEYS[key] === kind);
		faults.add(twins ? "twin-keys" : "node-kind", at, `\`${found.join("` and `")}\`: ${twins ? "a literal or an address, not both" : "a node has one kind"}`);
		return undefined;
	}
	const noRetry = RETRY_REFUSED[kind];
	faults.keys(raw, noRetry === undefined ? NODE_KEYS[kind] : [...NODE_KEYS[kind], "retry"], at, `keys of ${kind} nodes`);
	if (noRetry !== undefined && raw.retry !== undefined) faults.add("retry-refused", `${at}.retry`, noRetry);
	if (id === undefined) return undefined;
	const continueOnFail = raw["on-fail"] !== undefined && onFail(raw["on-fail"], `${at}.on-fail`, faults);
	const sequence = (value: unknown, key: string) => readSequence(value, `${at}.${key}`, at, context, kinds);
	return kinds[kind]({ raw, id, at, faults, continueOnFail, sequence });
}

function readId(value: unknown, place: string, path: string, { faults, seen }: ReadContext): string | undefined {
	if (value === undefined) {
		faults.add("missing-key", `${place}.id`, "every node has an `id:`");
		return undefined;
	}
	const id = text(value, `${place}.id`, faults);
	if (id === undefined) return undefined;
	const at = under(path, id);
	if (!ID.test(id)) {
		faults.add("invalid-id", at, `\`${id}\`: an id is letters, digits and \`_\`, since addresses and conditions read it${id.includes("-") ? `; name it \`${id.replaceAll("-", "_")}\`` : ""}`);
	} else if (ADDRESS_WORDS.includes(id) || isReserved(id)) {
		faults.add("reserved-id", at, `\`${id}\` is a word ${ADDRESS_WORDS.includes(id) ? "an address" : "CEL"} reserves`);
	} else if (seen.has(id)) {
		faults.add("duplicate-id", at, `\`${id}\` names another node of this file: an id is unique in the whole file`);
	} else {
		seen.add(id);
		return id;
	}
	return undefined;
}

/** The address of the node `id` inside the one at `path`. */
function under(path: string, id: string): string {
	return path === "" ? id : `${path}/${id}`;
}

function onFail(value: unknown, at: string, faults: FaultList): boolean {
	if (value === "continue") return true;
	faults.add("key-type", at, "takes `continue`");
	return false;
}

/**
 * A fault's rank among a node's keys, in the order written: the node's own
 * faults first, then each key's, a nested node's with the key holding it.
 */
function rankIn(keys: readonly string[], at: string): (fault: Fault) => number {
	const body = keys.find((key) => BODY_KEYS.includes(key));
	return (fault) => {
		if (!fault.at.startsWith(at)) return keys.length;
		const rest = fault.at.slice(at.length);
		if (rest === "") return -1;
		if (rest.startsWith("/")) return body === undefined ? keys.length : rankOf(keys, body);
		return rankOf(keys, /^\.([^.[]+)/.exec(rest)?.[1] ?? "");
	};
}

/** Where `word` stands in `words`, the end when it is not there. */
export function rankOf(words: readonly (string | undefined)[], word: string): number {
	const index = words.indexOf(word);
	return index === -1 ? words.length : index;
}

/** Whether a YAML value is a mapping. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
