/**
 * A checked flow: what validation hands the runner, the renderings and the
 * dry run once it found no fault.
 *
 * Names are resolved (each agent attached, each read typed), the prose is
 * attached to its node, and nothing in it can refer to something missing. The
 * runner takes nothing else, which is what keeps "validated whole before the
 * first spawn" true by construction rather than by care: only `checkFlow`
 * makes one.
 */

import type { Agent } from "../agent.ts";
import type { Choice } from "../ask.ts";
import type { AskForm } from "./node.ts";
import type { Condition } from "./condition/index.ts";
import type { Field, ValueType } from "./type.ts";

/** Why a node failed. A closed set, so a condition reading `x.error.kind` is checked like any enum. */
export const ERROR_KINDS = [
	"provider",
	"timeout",
	"schema",
	"stopped",
	"cancelled",
	"condition",
	"child",
	"nobody",
	"unavailable",
	"empty-message",
	"unconverged",
	"too-many",
] as const;

/** One of {@link ERROR_KINDS}. */
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** Why a node that could not run did not: what `x.error` reads. */
export type FlowError = { readonly kind: ErrorKind; readonly message: string };

/** One read handed to a turn: the address as written, and the type it names. */
export type CheckedRead = { readonly address: string; readonly type: ValueType };

/** What every checked node has. */
type Common = {
	readonly id: string;
	/** The node's address through its enclosing nodes, without iterations. */
	readonly at: string;
	readonly continueOnFail: boolean;
};

/** An `agent` node, resolved. */
export type CheckedAgentNode = Common & {
	readonly kind: "agent";
	/** The agent, or the address a value picks it from and the closed set it picks in, by name. */
	readonly agent: Agent | { readonly from: string; readonly among: ReadonlyMap<string, Agent> };
	/** Its `## <id>` section, trimmed. */
	readonly prose: string;
	readonly memory?: string;
	readonly reads: readonly CheckedRead[];
	readonly output?: ValueType;
	/** The enclosing node whose ledger the `verdict` tool writes to; the output is then {@link VERDICT}. */
	readonly verdict?: string;
	readonly retry: number;
	readonly timeoutMs?: number;
};

/** A `choice`, its conditions compiled. */
export type CheckedChoiceNode = Common & {
	readonly kind: "choice";
	readonly cases: readonly { readonly when: Condition; readonly nodes: readonly CheckedNode[] }[];
	readonly otherwise: readonly CheckedNode[];
};

/** A `parallel`, its branches in the order written. */
export type CheckedParallelNode = Common & {
	readonly kind: "parallel";
	readonly branches: readonly { readonly name: string; readonly nodes: readonly CheckedNode[] }[];
	readonly copies: boolean;
	readonly failFast: boolean;
};

/** A `map`, over a literal list or the list an address names. */
export type CheckedMapNode = Common & {
	readonly kind: "map";
	readonly over: { readonly items: readonly string[] } | { readonly from: string };
	readonly max?: number;
	readonly concurrency: number;
	readonly copies: boolean;
	readonly failFast: boolean;
	readonly ledger: boolean;
	readonly nodes: readonly CheckedNode[];
};

/** A `loop`, its conditions compiled. */
export type CheckedLoopNode = Common & {
	readonly kind: "loop";
	readonly until: Condition;
	readonly max: number;
	readonly giveUp?: Condition;
	readonly carry?: { readonly first: string; readonly next: string };
	readonly ledger: boolean;
	readonly nodes: readonly CheckedNode[];
};

/** A `check`: a script of the project, whose content the run stage reads. */
export type CheckedCheckNode = Common & {
	readonly kind: "check";
	/** Its path from the repository root. */
	readonly script: string;
	readonly timeoutMs: number;
};

/** A `commit`, its message's address typed as a text. */
export type CheckedCommitNode = Common & {
	readonly kind: "commit";
	readonly message: string;
};

/** An `ask`, its reads typed and its output typed by its form. */
export type CheckedAskNode = Common & {
	readonly kind: "ask";
	readonly question: { readonly text: string } | { readonly from: string };
	readonly form: AskForm;
	readonly options?: readonly Choice[];
	readonly enough?: string;
	readonly default?: string | boolean;
	readonly reads: readonly CheckedRead[];
	readonly timeoutMs?: number;
	readonly output: ValueType;
};

/** A node of any kind, resolved. */
export type CheckedNode = CheckedAgentNode | CheckedChoiceNode | CheckedParallelNode | CheckedMapNode | CheckedLoopNode | CheckedCheckNode | CheckedCommitNode | CheckedAskNode;

declare const checked: unique symbol;

/** A flow that passed the flow stage of validation. Only `checkFlow` makes one. */
export type CheckedFlow = {
	readonly name: string;
	readonly file: string;
	readonly description: string;
	readonly input: ValueType;
	readonly model?: string;
	readonly timeoutMs?: number;
	readonly nodes: readonly CheckedNode[];
	readonly [checked]: true;
};

const STRING: ValueType = { kind: "string" };

/** What a `verdict:` node outputs: the decision, and the short form of why. */
export const VERDICT: ValueType = {
	kind: "object",
	fields: { approved: { type: { kind: "boolean" }, optional: false }, remarks: { type: STRING, optional: true } },
};

/**
 * What a `check` outputs once it ran: whether its script exited 0, and the
 * end of what it wrote. A red check is a value a condition reads, not a failure.
 */
export const CHECK: ValueType = {
	kind: "object",
	fields: { passed: { type: { kind: "boolean" }, optional: false }, report: { type: STRING, optional: false } },
};

/**
 * What a `commit` outputs: whether it made one, its short sha when it did,
 * and the run's branch either way. A clean tree is a value, not a failure.
 */
export const COMMIT: ValueType = {
	kind: "object",
	fields: { committed: { type: { kind: "boolean" }, optional: false }, sha: { type: STRING, optional: true }, branch: { type: STRING, optional: false } },
};

/**
 * What a branch of a `copies: true` block adds to its entry in the block's
 * output: whether all it changed reached the tree, and when its patch is the
 * one that stopped the landing, why.
 */
export const LANDED: Readonly<Record<string, Field>> = {
	landed: { type: { kind: "boolean" }, optional: false },
	refused: { type: STRING, optional: true },
};

/** The open obligations of a ledger, as `<scope>.ledger` reads them. */
export const LEDGER: ValueType = {
	kind: "list",
	of: { kind: "object", fields: { id: { type: STRING, optional: false }, text: { type: STRING, optional: false } } },
};

/** How a loop stopped: its condition held, it gave up, or it reached its cap. */
export const STOPS = ["until", "give-up", "cap"] as const;

/** The value of each `choice` case, and of its default, as `case` names them: `"1"` for the first. */
export function caseNames(count: number): string[] {
	return [...Array.from({ length: count }, (_, i) => String(i + 1)), "default"];
}

/**
 * A node as an address and a condition see it once it ended: whether it ran,
 * its output when it did, and why not when it did not.
 */
export function endedNode(output: ValueType): ValueType {
	return {
		kind: "object",
		fields: {
			ok: { type: { kind: "boolean" }, optional: false },
			output: { type: output, optional: true },
			error: {
				type: { kind: "object", fields: { kind: { type: { kind: "enum", values: ERROR_KINDS }, optional: false }, message: { type: { kind: "string" }, optional: false } } },
				optional: true,
			},
		},
	};
}
