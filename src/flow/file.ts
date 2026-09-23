/**
 * A flow file turned into nodes: YAML frontmatter for the structure, one
 * `## <id>` section of Markdown per `agent` node for the prose.
 *
 * A flow is **a closed language, not a general one**. It has branches and
 * loops, and it stays safe because every construct comes from the closed
 * lists below, every loop and `map` carries a bound written in the file, and
 * every condition terminates and gives the same answer for the same values. So
 * the worst case of a run is known before its first spawn. That is the test
 * for any new key: a key that would make the worst case unknowable is a
 * TypeScript workflow instead.
 *
 * And the reason any of this exists: **no agent reads this file to decide
 * what happens next.** Our runner walks it. A model produces values, and our
 * code reads them.
 *
 * This file reads a flow's text into nodes and refuses what it does not
 * understand. The keys of the file are the list below; the kinds of node and
 * the keys of each are the lists at the top of `node.ts`, and `read-node.ts`
 * refuses a key valid on another kind too. Resolving names against the catalogue happens in
 * `check.ts`, still before any spawn.
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { FaultList, type Fault } from "./fault.ts";
import { readAgent } from "./agent-node.ts";
import { readChoice, readMap, readParallel } from "./blocks.ts";
import { readLoop } from "./loop.ts";
import { everyNode, type FlowNode, type KindReader, type NodeKind } from "./node.ts";
import { rankOf, readSequence } from "./read-node.ts";
import { readSchema } from "./schema.ts";
import { readSections } from "./sections.ts";
import type { ValueType } from "./type.ts";
import { duration, text } from "./value.ts";

/** The keys of a flow's frontmatter, and whether each is required. */
export const FLOW_KEYS = { name: true, description: true, input: true, model: false, timeout: false, nodes: true } as const;

/** The reader of each kind of node. */
const KINDS: Readonly<Record<NodeKind, KindReader>> = { agent: readAgent, choice: readChoice, parallel: readParallel, map: readMap, loop: readLoop };

/** A flow file, read: nothing in it is resolved against a catalogue yet. */
export type FlowFile = {
	readonly file: string;
	readonly name: string;
	readonly description: string;
	readonly input: ValueType;
	readonly model?: string;
	readonly timeoutMs?: number;
	/** The root sequence, without the nodes that were refused. */
	readonly nodes: readonly FlowNode[];
	/** Ids of refused nodes: what refers to one is not reported again. */
	readonly refused: ReadonlySet<string>;
	/** Where each fault of this file stands in it, so they come back in file order. */
	readonly rank: (fault: Fault) => number;
	/** The prose of each `agent` node, by id; ids are unique in the whole file. */
	readonly sections: ReadonlyMap<string, string>;
};

/**
 * A flow file read, and every fault found in it.
 *
 * `flow` is there whenever the frontmatter could be read, faults or not, so
 * the names it holds are checked too and a flow is refused with every fault
 * at once. What was refused is left out of it, and listed in `refused`.
 */
export type ReadFlow = { readonly flow?: FlowFile; readonly faults: FaultList };

/**
 * `content`, the text of the flow file at `file`, read into nodes.
 *
 * A YAML syntax error is the only fault returned when there is one, with the
 * line in the file, since nothing past it can be read.
 */
export function readFlow(content: string, file: string): ReadFlow {
	const faults = new FaultList(file);
	let parsed: { frontmatter: unknown; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (error) {
		const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
		const reason = (error as Error).message.split(" at line")[0] ?? (error as Error).message;
		faults.add("yaml-syntax", "", line === undefined ? reason : `${reason}, line ${line + 1}`);
		return { faults };
	}
	const { frontmatter, body } = parsed;
	if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter) || Object.keys(frontmatter).length === 0) {
		faults.add("not-a-flow", "", "a flow starts with YAML frontmatter holding `name`, `description`, `input` and `nodes`");
		return { faults };
	}
	const keys = frontmatter as Record<string, unknown>;
	faults.keys(keys, Object.keys(FLOW_KEYS), "", "flow keys");
	for (const [key, required] of Object.entries(FLOW_KEYS)) {
		if (required && keys[key] === undefined) faults.add("missing-key", key, `a flow has \`${key}:\``);
	}

	const name = keys.name === undefined ? undefined : text(keys.name, "name", faults);
	const description = keys.description === undefined ? undefined : text(keys.description, "description", faults);
	const input = keys.input === undefined ? undefined : readInput(keys.input, faults);
	const model = keys.model === undefined ? undefined : text(keys.model, "model", faults);
	const timeoutMs = keys.timeout === undefined ? undefined : duration(keys.timeout, "timeout", faults);
	const refused = new Set<string>();
	if (Array.isArray(keys.nodes) && keys.nodes.length === 0) faults.add("key-type", "nodes", "a flow runs at least one node");
	const nodes = readSequence(keys.nodes, "nodes", "", { faults, seen: new Set(), refused }, KINDS);
	const ids = Array.isArray(keys.nodes) ? keys.nodes.map((raw: unknown) => (raw as { id?: unknown } | null)?.id) : [];
	const sections = checkSections(body, [...everyNode(nodes)], refused, faults);

	// A broken input is refused once: what reads it is not reported again.
	if (input === undefined) refused.add("input");
	const rank = (fault: Fault) => position(Object.keys(keys), ids as (string | undefined)[], fault);
	const flow = { file, name: name ?? "", description: description ?? "", input: input ?? { kind: "text" }, model, timeoutMs, nodes, refused, rank, sections } as const;
	faults.sort(rank);
	return { flow, faults };
}

/** The body's sections, each held to an `agent` node, and every `agent` node to its section. */
function checkSections(body: string, nodes: readonly FlowNode[], refused: ReadonlySet<string>, faults: FaultList): ReadonlyMap<string, string> {
	const { sections, problems } = readSections(body);
	for (const problem of problems) faults.add(problem.code, problem.at, problem.message);
	for (const id of sections.keys()) {
		const node = nodes.find((candidate) => candidate.id === id);
		if (node !== undefined && node.kind !== "agent") faults.add("section-not-agent", node.at, `\`## ${id}\`: \`${id}\` is a ${node.kind} node, and only an agent node's turn reads prose`);
		else if (node === undefined && !refused.has(id)) faults.unknown("section-unknown", id, id, nodes.filter((n) => n.kind === "agent").map((n) => n.id), "agent node ids");
	}
	for (const node of nodes) {
		if (node.kind === "agent" && !sections.has(node.id)) faults.add("section-missing", node.at, `\`${node.id}\` is an agent node and has no \`## ${node.id}\` section`);
	}
	return sections;
}

/** `input: string` is what follows the command; a schema types it. */
function readInput(written: unknown, faults: FaultList): ValueType | undefined {
	const schema = readSchema(written);
	if (schema.ok) return schema.type;
	for (const problem of schema.problems) faults.add(problem.code, problem.at === "" ? "input" : `input.${problem.at}`, problem.message);
	return undefined;
}

const BODY_CODES = new Set(["body-preamble", "section-unknown", "section-empty", "section-duplicate"]);

/**
 * A fault's position: the flow's keys in the order written, then each node in
 * the order written (a node's missing section with it), then the body.
 */
function position(keys: readonly string[], ids: readonly (string | undefined)[], fault: Fault): number {
	if (BODY_CODES.has(fault.code)) return keys.length + ids.length + 1;
	const head = fault.at.split(/[.[/]/)[0] ?? "";
	const place = /^nodes\[(\d+)\]/.exec(fault.at);
	if (place) return keys.length + Number(place[1]);
	if (ids.includes(head)) return keys.length + rankOf(ids, head);
	return head === "nodes" ? keys.length + ids.length : rankOf(keys, head);
}
