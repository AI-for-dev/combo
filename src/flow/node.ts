/**
 * What a read flow is made of: its nodes, each `id:` plus exactly one kind
 * key holding its main argument and that kind's options beside it.
 *
 * The kinds, and the keys of each, are the closed lists right below. Nothing
 * outside them is ever read; `read-node.ts` refuses it.
 */

import type { Choice } from "../ask.ts";
import type { FaultList } from "./fault.ts";
import type { ValueType } from "./type.ts";

/**
 * The kinds of node, by the key that names each one: a node is `id:` plus
 * exactly one of these, holding its main argument. A `-from` key takes an
 * address where its twin takes a literal.
 */
export const KIND_KEYS = {
	agent: "agent",
	"agent-from": "agent",
	choice: "choice",
	parallel: "parallel",
	map: "map",
	"map-from": "map",
	loop: "loop",
	check: "check",
	commit: "commit",
	ask: "ask",
	"ask-from": "ask",
} as const;

/** Every key a node of each kind may carry. Anything else is refused. */
export const NODE_KEYS = {
	agent: ["id", "agent", "agent-from", "among", "memory", "reads", "output", "verdict", "retry", "timeout", "on-fail"],
	choice: ["id", "choice", "default", "on-fail"],
	parallel: ["id", "parallel", "copies", "fail-fast", "on-fail"],
	map: ["id", "map", "map-from", "max", "concurrency", "copies", "fail-fast", "ledger", "do", "on-fail"],
	loop: ["id", "loop", "max", "give-up", "carry", "ledger", "do", "on-fail"],
	check: ["id", "check", "timeout", "on-fail"],
	commit: ["id", "commit", "on-fail"],
	ask: ["id", "ask", "ask-from", "options", "confirm", "enough", "default", "reads", "timeout", "on-fail"],
} as const;

/**
 * The kinds that refuse `retry:`, each with what to do instead. It is refused
 * with its own reason rather than as an unknown key, since an author who
 * wrote it meant something the kind has an answer to.
 */
export const RETRY_REFUSED: Partial<Record<NodeKind, string>> = {
	check: "a check is not retried: raise `timeout:`, or make the check stable",
	commit: "a commit is not retried: what git refused is a hook or a lock to fix, and the node writing the message can take `retry:`",
	ask: "an ask is not retried: a person answered it, or nobody was there to; `default:` says what nobody answering gives",
};

/** A kind of node. */
export type NodeKind = keyof typeof NODE_KEYS;

/** What every node has. */
type Common = {
	readonly id: string;
	/** The node's address through its enclosing nodes, without iterations: `work/pair/code`. */
	readonly at: string;
	/** `on-fail: continue`: a failure stops here instead of travelling up. */
	readonly continueOnFail: boolean;
};

/** One turn of an agent, named in the file or taken from a value within a closed set. */
export type AgentNode = Common & {
	readonly kind: "agent";
	readonly agent: { readonly name: string } | { readonly from: string; readonly among: readonly string[] };
	/** The enclosing node, or `flow`, whose subagent this turn resumes. Absent: a fresh subagent. */
	readonly memory?: string;
	/** The addresses handed to the turn, in order. */
	readonly reads: readonly string[];
	/** The schema of a typed output. Absent: the output is the agent's text. */
	readonly output?: ValueType;
	/** The enclosing node whose ledger this turn's `verdict` tool writes to. */
	readonly verdict?: string;
	readonly retry: number;
	readonly timeoutMs?: number;
};

/** Ordered cases, the first whose condition holds running, and a default. */
export type ChoiceNode = Common & {
	readonly kind: "choice";
	readonly cases: readonly { readonly when: string; readonly nodes: readonly FlowNode[] }[];
	readonly otherwise: readonly FlowNode[];
};

/** Branches written in the file, all started at once and joined when all end. */
export type ParallelNode = Common & {
	readonly kind: "parallel";
	readonly branches: readonly { readonly name: string; readonly nodes: readonly FlowNode[] }[];
	readonly copies: boolean;
	readonly failFast: boolean;
};

/** One run of its body per item of a list, written in the file or read from an address. */
export type MapNode = Common & {
	readonly kind: "map";
	readonly over: { readonly items: readonly string[] } | { readonly from: string };
	/** The longest list `map-from` takes; a literal list is its own bound. */
	readonly max?: number;
	readonly concurrency: number;
	readonly copies: boolean;
	readonly failFast: boolean;
	/** Each item keeps a ledger of its own. */
	readonly ledger: boolean;
	readonly nodes: readonly FlowNode[];
};

/** Its body, `do:`, again and again until its condition holds, at most `max` times. */
export type LoopNode = Common & {
	readonly kind: "loop";
	/** The condition that ends the loop converged, read at the end of each iteration. */
	readonly until: string;
	readonly max: number;
	/** A condition read when `until` is false, that ends the loop not converged. */
	readonly giveUp?: string;
	/** What the first iteration reads as `<loop>.carry`, and what each next one does. */
	readonly carry?: { readonly first: string; readonly next: string };
	/** The loop keeps a ledger across its iterations. */
	readonly ledger: boolean;
	readonly nodes: readonly FlowNode[];
};

/** A script of the project, run with `bash` in the working tree the node sits in. */
export type CheckNode = Common & {
	readonly kind: "check";
	/** Its path from the repository root, normalised. */
	readonly script: string;
	readonly timeoutMs: number;
};

/** Everything in the working tree committed, on the run's own branch. */
export type CommitNode = Common & {
	readonly kind: "commit";
	/** The address of the message, an earlier node's output. */
	readonly message: string;
};

/**
 * What an `ask` puts to a person, by what is written: a choice card with
 * `options:` or `ask-from:`, a yes or no with `confirm: true`, a free text
 * with neither.
 */
export type AskForm = "choice" | "confirm" | "text";

/** A question put to a person, written in the file or taken from a `Question` value. */
export type AskNode = Common & {
	readonly kind: "ask";
	readonly question: { readonly text: string } | { readonly from: string };
	readonly form: AskForm;
	/** The literal options of a choice card, in order. */
	readonly options?: readonly Choice[];
	/** The label of "that's enough", offered only on a choice card. */
	readonly enough?: string;
	/** What nobody answering gives: a label, a text, or `true`/`false` for a confirm. */
	readonly default?: string | boolean;
	readonly reads: readonly string[];
	readonly timeoutMs?: number;
};

/** A node of any kind. */
export type FlowNode = AgentNode | ChoiceNode | ParallelNode | MapNode | LoopNode | CheckNode | CommitNode | AskNode;

/** What reading a whole file shares, from one node to the next and into nested ones. */
export type ReadContext = {
	readonly faults: FaultList;
	/** Every id taken so far in the file: an id is unique in the whole file. */
	readonly seen: Set<string>;
	/**
	 * Ids nothing should be reported about again: refused nodes at any depth,
	 * and the blocks holding one, whose output cannot be typed.
	 */
	readonly refused: Set<string>;
};

/** What a kind's reader is handed: the node's mapping, its id and address, and how to read a nested sequence. */
export type NodeReading = {
	readonly raw: Readonly<Record<string, unknown>>;
	readonly id: string;
	readonly at: string;
	readonly faults: FaultList;
	readonly continueOnFail: boolean;
	/** The sequence under `key`, whose nodes sit under this one. */
	sequence(value: unknown, key: string): FlowNode[];
};

/** Reads the options of one kind, or `undefined` when a fault refused it. */
export type KindReader = (node: NodeReading) => FlowNode | undefined;

/** A tree of nodes, read or checked: both hold their nested sequences under the same keys. */
type Tree = {
	readonly kind: string;
	readonly cases?: readonly { readonly nodes: readonly unknown[] }[];
	readonly otherwise?: readonly unknown[];
	readonly branches?: readonly { readonly nodes: readonly unknown[] }[];
	readonly nodes?: readonly unknown[];
};

/** Every node of `nodes`, nested ones included, parents first. */
export function* everyNode<T extends Tree>(nodes: readonly T[]): Generator<T> {
	for (const node of nodes) {
		yield node;
		const nested = [...(node.cases ?? []).flatMap((c) => c.nodes), ...(node.otherwise ?? []), ...(node.branches ?? []).flatMap((b) => b.nodes), ...(node.nodes ?? [])];
		yield* everyNode(nested as T[]);
	}
}
