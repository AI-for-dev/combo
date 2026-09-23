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
import type { Condition } from "./condition/index.ts";
import type { ValueType } from "./type.ts";

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
	readonly nodes: readonly CheckedNode[];
};

/** A node of any kind, resolved. */
export type CheckedNode = CheckedAgentNode | CheckedChoiceNode | CheckedParallelNode | CheckedMapNode;

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
