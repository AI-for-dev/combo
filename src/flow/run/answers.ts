/**
 * A dry run's script: the answers that stand in for each agent turn and each
 * check's script run, checked against the flow before the first one is taken.
 *
 * A key is a node's address (`gate/ask`) or an exact visit path
 * (`deliver#2/gate/ask`), the path winning. Its value is one answer, which
 * serves every attempt, or a list, consumed attempt by attempt within the
 * enclosing path, so each item of a `map` has its own list and a loop's
 * iterations share one. A list is always a list of answers, so a node whose
 * output is a list is answered inside one: `[["a", "b"]]`. An answer is an
 * output, the `verdict` call of a `verdict:` node, a check's `{ passed,
 * report }`, a commit's `{ committed, sha?, branch }`, or `{ fail: <kind> }`.
 */

import { VERDICT_TOOL } from "../../review/index.ts";
import type { ScriptOutcome } from "../../verify.ts";
import { CHECK, COMMIT, type CheckedAgentNode, type CheckedFlow } from "../checked.ts";
import type { CommitOutcome } from "./commit.ts";
import { nearest } from "../fault.ts";
import { mismatch, type ValueType } from "../type.ts";
import { answeredNodes, visitAt, type AnsweredNode, type Keyed, type Unkeyed } from "./keys.ts";
import type { ScriptedTurn } from "./scripted.ts";
import { submission, SUBMIT_TOOL } from "./submit.ts";

/** Why a script is refused. Stable, so a test of a flow can assert on them. */
export const ANSWER_CODES = ["answer-unknown-node", "answer-past-max", "answer-off-schema", "answer-fail-kind"] as const;

/** A script's mistake: its code, the key (and its place in a list), and one sentence. */
export type AnswerFault = { readonly code: (typeof ANSWER_CODES)[number]; readonly at: string; readonly message: string };

/** The answers of a dry run, by node address or visit path. */
export type Answers = Readonly<Record<string, unknown>>;

/** How a scripted node can fail: what it can end with on its own, short of a person or a cut. */
const FAILS = { agent: ["provider", "timeout", "schema"], check: ["unavailable", "timeout"], commit: ["unavailable"] } as const;

/** What each kind of node a script answers is asked to say, by name in a fault. */
const ANSWERED = { agent: "an agent turn", check: "a check", commit: "a commit" } as const;

const TEXT: ValueType = { kind: "text" };
const STRING: ValueType = { kind: "string" };

/** What a `verdict:` node's answer is: the `verdict` tool's own parameters. */
const VERDICT_CALL: ValueType = {
	kind: "object",
	fields: {
		approved: { type: { kind: "boolean" }, optional: false },
		remarks: { type: STRING, optional: true },
		resolved: {
			type: {
				kind: "list",
				of: {
					kind: "object",
					fields: {
						id: { type: STRING, optional: false },
						how: { type: { kind: "enum", values: ["addressed", "withdrawn"] }, optional: false },
						reason: { type: STRING, optional: true },
					},
				},
			},
			optional: true,
		},
		raised: { type: { kind: "list", of: STRING }, optional: true },
	},
};

/** A checked script, handing out one turn per attempt. */
export class Script {
	private readonly answers: Answers;
	private readonly nodes: ReadonlyMap<string, AnsweredNode>;
	private readonly taken = new Map<string, number>();

	private constructor(answers: Answers, nodes: ReadonlyMap<string, AnsweredNode>) {
		this.answers = answers;
		this.nodes = nodes;
	}

	/** `answers` checked against `flow`: a script, or every fault found in it. */
	static check(flow: CheckedFlow, answers: Answers): { ok: true; script: Script } | { ok: false; faults: AnswerFault[] } {
		const nodes = answeredNodes(flow.nodes);
		const faults: AnswerFault[] = [];
		for (const [key, value] of Object.entries(answers)) {
			const keyed = nodes.get(key) ?? visitAt(flow.nodes, key);
			if ("code" in keyed) {
				faults.push({ code: keyed.code, at: key, message: unkeyed(key, keyed, nodes) });
				continue;
			}
			const list = Array.isArray(value) ? value : [value];
			for (const [index, answer] of list.entries()) {
				const fault = checkAnswer(answer, keyed.node, Array.isArray(value) ? `${key}[${index}]` : key);
				if (fault !== undefined) faults.push(fault);
			}
			if (list.length > keyed.most) {
				faults.push({ code: "answer-past-max", at: key, message: `\`${key}\` is asked ${keyed.most} time${keyed.most === 1 ? "" : "s"} at most, and its list holds ${list.length} answers` });
			}
		}
		const byAddress = new Map([...nodes].map(([at, { node }]) => [at, node]));
		return faults.length > 0 ? { ok: false, faults } : { ok: true, script: new Script(answers, byAddress) };
	}

	/**
	 * The turn the attempt at visit `path`, of the agent node at `at`, takes,
	 * or `undefined` when nothing scripts it.
	 */
	next(path: string, at: string): ScriptedTurn | undefined {
		const answer = this.take(path, at);
		return answer && turn(answer.value, this.nodes.get(at) as CheckedAgentNode);
	}

	/**
	 * How the check or the commit at `at` ends at visit `path`, or `undefined`
	 * when nothing scripts it: the outcome its port would give.
	 */
	ran<T extends ScriptOutcome | CommitOutcome>(path: string, at: string): T | undefined {
		const answer = this.take(path, at);
		if (answer === undefined) return undefined;
		if (!isFail(answer.value)) return { ok: true, ...(answer.value as object) } as T;
		const kind = answer.value.fail as string;
		return { ok: false, kind, message: `scripted ${kind} failure` } as T;
	}

	/** The answer the visit `path` of the node at `at` takes: its path's, else its address's, one per attempt from a list. */
	private take(path: string, at: string): { readonly value: unknown } | undefined {
		const key = [path, at].find((one) => Object.hasOwn(this.answers, one));
		if (key === undefined) return undefined;
		const value = this.answers[key];
		if (!Array.isArray(value)) return { value };
		const cursor = key === path ? path : `${key}@${path.replace(/#\d+/g, "")}`;
		const index = this.taken.get(cursor) ?? 0;
		this.taken.set(cursor, index + 1);
		return index < value.length ? { value: value[index] } : undefined;
	}
}

/** Why `key` names no visit, offering the address meant when it can. */
function unkeyed(key: string, { code, why }: Unkeyed, nodes: ReadonlyMap<string, Keyed>): string {
	if (code === "answer-past-max") return `\`${key}\`: ${why}`;
	// An id alone is the likeliest slip: it is how the node is written.
	const near = [...nodes.values()].find(({ node }) => node.id === key)?.node.at ?? nearest(key.replace(/#\d+|\[\d+\]/g, ""), nodes.keys());
	const said = why ?? (near === undefined ? undefined : `did you mean \`${near}\`?`);
	return `\`${key}\` names no agent, check or commit node${said === undefined ? "" : `: ${said}`}`;
}

function isFail(answer: unknown): answer is { fail: unknown } {
	return typeof answer === "object" && answer !== null && !Array.isArray(answer) && Object.keys(answer).length === 1 && "fail" in answer;
}

/** Checked by the same `mismatch` a real submission passes, or a check's output is held to. */
function checkAnswer(answer: unknown, node: AnsweredNode, at: string): AnswerFault | undefined {
	if (isFail(answer)) {
		const fails: readonly unknown[] = FAILS[node.kind];
		if (fails.includes(answer.fail)) return undefined;
		return { code: "answer-fail-kind", at, message: `${ANSWERED[node.kind]} fails with ${fails.join(", ")}, not ${JSON.stringify(answer.fail)}` };
	}
	const problem = mismatch(answer, node.kind === "check" ? CHECK : node.kind === "commit" ? COMMIT : node.verdict === undefined ? (node.output ?? TEXT) : VERDICT_CALL);
	return problem === undefined ? undefined : { code: "answer-off-schema", at, message: problem };
}

function turn(answer: unknown, node: CheckedAgentNode): ScriptedTurn {
	if (isFail(answer)) return { fail: answer.fail as (typeof FAILS.agent)[number] };
	if (node.verdict !== undefined) return { call: VERDICT_TOOL, args: answer };
	return node.output === undefined ? { say: answer as string } : { call: SUBMIT_TOOL, args: submission(answer, node.output) };
}
