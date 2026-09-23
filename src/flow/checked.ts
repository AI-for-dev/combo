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
import type { Bounds } from "./bounds.ts";
import type { AskForm } from "./node.ts";
import type { Condition } from "./condition/index.ts";
import type { Sources } from "./sources.ts";
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
export type FlowError = {
	/** Which of {@link ERROR_KINDS}: what a condition compares. */
	readonly kind: ErrorKind;
	/** One sentence, for the person reading the run. */
	readonly message: string;
};

/** One read handed to a turn: the address as written, and the type it names. */
export type CheckedRead = {
	/** The address as the file writes it, which is also the heading the turn shows it under. */
	readonly address: string;
	/** The type of what it reads. */
	readonly type: ValueType;
};

/** What every checked node has. */
type Common = {
	readonly id: string;
	/** The node's address through its enclosing nodes, without iterations. */
	readonly at: string;
	readonly continueOnFail: boolean;
};

/** An `agent` node, resolved. */
export type CheckedAgentNode = Common & {
	/** What tells the node kinds apart: the file's kind key. */
	readonly kind: "agent";
	/** The agent, or the address a value picks it from and the closed set it picks in, by name. */
	readonly agent: Agent | { readonly from: string; readonly among: ReadonlyMap<string, Agent> };
	/** Its `## <id>` section, trimmed. */
	readonly prose: string;
	/** The enclosing node, or `flow`, whose scope keeps this node's subagent across visits. Absent, each visit spawns its own. */
	readonly memory?: string;
	/** What the turn is handed, in the order written. */
	readonly reads: readonly CheckedRead[];
	/** The schema its `submit` call answers to. Absent, the turn's output is its text. */
	readonly output?: ValueType;
	/** The enclosing node whose ledger the `verdict` tool writes to; the output is then {@link VERDICT}. */
	readonly verdict?: string;
	/** How many times a failed turn is tried again, `0` when the file says none. */
	readonly retry: number;
	/** The node's own bound on one turn; absent, the flow's or the default, as `turnTimeout` says. */
	readonly timeoutMs?: number;
};

/** A `choice`, its conditions compiled. */
export type CheckedChoiceNode = Common & {
	/** What tells the node kinds apart: the file's kind key. */
	readonly kind: "choice";
	/** Each case in the order written, the first whose `when` holds running. */
	readonly cases: readonly { readonly when: Condition; readonly nodes: readonly CheckedNode[] }[];
	/** What runs when no case holds, its `default:`, empty for `[]`. */
	readonly otherwise: readonly CheckedNode[];
};

/** A `parallel`, its branches in the order written. */
export type CheckedParallelNode = Common & {
	/** What tells the node kinds apart: the file's kind key. */
	readonly kind: "parallel";
	/** Each branch, by its name, and its sequence. */
	readonly branches: readonly { readonly name: string; readonly nodes: readonly CheckedNode[] }[];
	/** Whether each branch runs in its own copy of the tree, landed after the join. */
	readonly copies: boolean;
	/** Whether the first failed branch stops the others. */
	readonly failFast: boolean;
};

/** A `map`, over a literal list or the list an address names. */
export type CheckedMapNode = Common & {
	/** What tells the node kinds apart: the file's kind key. */
	readonly kind: "map";
	/** The literal items, or the address of the list it runs over. */
	readonly over: { readonly items: readonly string[] } | { readonly from: string };
	/** The most items a `map-from` takes; a longer list fails the node before any item runs. */
	readonly max?: number;
	/** How many items run at once. */
	readonly concurrency: number;
	/** Whether each item runs in its own copy of the tree, landed after the join. */
	readonly copies: boolean;
	/** Whether the first failed item stops the others. */
	readonly failFast: boolean;
	/** Whether the node keeps a ledger its verdict nodes write to. */
	readonly ledger: boolean;
	/** The sequence each item runs, reading it as `item`. */
	readonly nodes: readonly CheckedNode[];
};

/** A `loop`, its conditions compiled. */
export type CheckedLoopNode = Common & {
	/** What tells the node kinds apart: the file's kind key. */
	readonly kind: "loop";
	/** Read after each iteration: the loop has converged when it holds. */
	readonly until: Condition;
	/** The most iterations; reaching it ends the loop not converged. */
	readonly max: number;
	/** Read after an iteration whose `until` is false: the loop ends not converged when it holds. */
	readonly giveUp?: Condition;
	/** The addresses its `carry` reads, on the first iteration and on each one after. */
	readonly carry?: { readonly first: string; readonly next: string };
	/** Whether the node keeps a ledger its verdict nodes write to. */
	readonly ledger: boolean;
	/** The sequence each iteration runs. */
	readonly nodes: readonly CheckedNode[];
};

/** A `check`: a script of the project, whose content the run stage reads. */
export type CheckedCheckNode = Common & {
	/** What tells the node kinds apart: the file's kind key. */
	readonly kind: "check";
	/** Its path from the repository root. */
	readonly script: string;
	/** How long the script may run before it is killed and the check fails. */
	readonly timeoutMs: number;
};

/** A `commit`, its message's address typed as a text. */
export type CheckedCommitNode = Common & {
	/** What tells the node kinds apart: the file's kind key. */
	readonly kind: "commit";
	/** The address of the text the commit message is. */
	readonly message: string;
};

/** An `ask`, its reads typed and its output typed by its form. */
export type CheckedAskNode = Common & {
	/** What tells the node kinds apart: the file's kind key. */
	readonly kind: "ask";
	/** The question as written, or the address of the question an agent wrote. */
	readonly question: { readonly text: string } | { readonly from: string };
	/** What the card takes: a choice, a yes or no, or a free text. */
	readonly form: AskForm;
	/** The literal choices, when the file writes them. */
	readonly options?: readonly Choice[];
	/** The label of "that's enough", offered only on a choice card. */
	readonly enough?: string;
	/** The answer taken when nobody answers: nobody there, or its `timeout:` reached. */
	readonly default?: string | boolean;
	/** What the card shows above the question, in the order written. */
	readonly reads: readonly CheckedRead[];
	/** How long the card waits for an answer; absent, as long as the person takes. */
	readonly timeoutMs?: number;
	/** The type of the answer, set by the form. */
	readonly output: ValueType;
};

/** A `flow` node: the flow it calls, checked whole on its own, and what it hands in. */
export type CheckedCallNode = Common & {
	/** What tells the node kinds apart: the file's kind key. */
	readonly kind: "flow";
	/** The flow it calls, checked whole on its own. */
	readonly callee: CheckedFlow;
	/** The address the callee's `input` is read from, typed. */
	readonly input: CheckedRead;
};

/** A node of any kind, resolved. */
export type CheckedNode =
	| CheckedAgentNode
	| CheckedChoiceNode
	| CheckedParallelNode
	| CheckedMapNode
	| CheckedLoopNode
	| CheckedCheckNode
	| CheckedCommitNode
	| CheckedAskNode
	| CheckedCallNode;

declare const checked: unique symbol;

/** A flow that passed the flow stage of validation. Only `checkFlow` makes one. */
export type CheckedFlow = {
	/** Its file name without `.md`, which `name:` repeats. */
	readonly name: string;
	/** The path of its file. */
	readonly file: string;
	/** Its `description:`, one line. */
	readonly description: string;
	/** The type of what it is started on. */
	readonly input: ValueType;
	/** Its `model:`, which the model given at launch overrides. */
	readonly model?: string;
	/** Its `timeout:`, the bound of an agent turn whose node sets none. */
	readonly timeoutMs?: number;
	/** Its root sequence. */
	readonly nodes: readonly CheckedNode[];
	/** What its last root node outputs: what a `flow` node calling it hands on. */
	readonly output: ValueType;
	/** What its check read: its file and every one it reaches, each agent it names with its skills. */
	readonly sources: Sources;
	/** Its worst case as a root, sub-flows unrolled: shown by the plan, never judged. */
	readonly bounds: Bounds;
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
