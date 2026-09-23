/**
 * A dry run's script: the answers that stand in for each agent turn, checked
 * against the flow before the first one is taken.
 *
 * A key is a node's address (`gate/ask`) or an exact visit path
 * (`deliver#2/gate/ask`), the path winning. Its value is one answer, which
 * serves every attempt, or a list, consumed attempt by attempt. A list is
 * always a list of answers, so a node whose output is a list is answered
 * inside one: `[["a", "b"]]`. An answer is an output or `{ fail: <kind> }`.
 */

import type { CheckedAgentNode, CheckedFlow } from "../checked.ts";
import { nearest } from "../fault.ts";
import { everyNode } from "../node.ts";
import { mismatch, type ValueType } from "../type.ts";
import type { ScriptedTurn } from "./scripted.ts";
import { submission } from "./submit.ts";

/** Why a script is refused. Stable, so a test of a flow can assert on them. */
export const ANSWER_CODES = ["answer-unknown-node", "answer-off-schema", "answer-fail-kind"] as const;

/** A script's mistake: its code, the key (and its place in a list), and one sentence. */
export type AnswerFault = { readonly code: (typeof ANSWER_CODES)[number]; readonly at: string; readonly message: string };

/** The answers of a dry run, by node address or visit path. */
export type Answers = Readonly<Record<string, unknown>>;

/** How a scripted agent turn can fail: what an agent turn can end with, short of a person or a cut. */
const AGENT_FAILS = ["provider", "timeout", "schema"] as const;

const TEXT: ValueType = { kind: "text" };

/** A checked script, handing out one turn per attempt. */
export class Script {
	private readonly answers: Answers;
	private readonly nodes: ReadonlyMap<string, CheckedAgentNode>;
	private readonly taken = new Map<string, number>();

	private constructor(answers: Answers, nodes: ReadonlyMap<string, CheckedAgentNode>) {
		this.answers = answers;
		this.nodes = nodes;
	}

	/** `answers` checked against `flow`: a script, or every fault found in it. */
	static check(flow: CheckedFlow, answers: Answers): { ok: true; script: Script } | { ok: false; faults: AnswerFault[] } {
		const nodes = new Map<string, CheckedAgentNode>();
		for (const node of everyNode(flow.nodes)) if (node.kind === "agent") nodes.set(node.at, node);
		const faults: AnswerFault[] = [];
		for (const [key, value] of Object.entries(answers)) {
			const node = nodes.get(address(key));
			if (node === undefined) {
				// An id alone is the likeliest slip: it is how the node is written.
				const near = [...nodes.values()].find((one) => one.id === key)?.at ?? nearest(address(key), nodes.keys());
				faults.push({ code: "answer-unknown-node", at: key, message: `\`${key}\` names no agent node${near === undefined ? "" : `: did you mean \`${near}\`?`}` });
				continue;
			}
			const list = Array.isArray(value) ? value : [value];
			for (const [index, answer] of list.entries()) {
				const at = Array.isArray(value) ? `${key}[${index}]` : key;
				const fault = checkAnswer(answer, node, at);
				if (fault !== undefined) faults.push(fault);
			}
		}
		return faults.length > 0 ? { ok: false, faults } : { ok: true, script: new Script(answers, nodes) };
	}

	/**
	 * The turn the attempt at visit `path` takes, or `undefined` when nothing
	 * scripts it. A node's list is consumed within its enclosing path, so each
	 * item of a `map` has its own and a loop's iterations share one.
	 */
	next(path: string): ScriptedTurn | undefined {
		const at = address(path);
		const node = this.nodes.get(at) as CheckedAgentNode;
		const key = [path, at].find((one) => Object.hasOwn(this.answers, one));
		if (key === undefined) return undefined;
		const value = this.answers[key];
		if (!Array.isArray(value)) return turn(value, node);
		const cursor = key === path ? path : `${key}@${path.replace(/#\d+/g, "")}`;
		const index = this.taken.get(cursor) ?? 0;
		this.taken.set(cursor, index + 1);
		return index < value.length ? turn(value[index], node) : undefined;
	}
}

/** A visit path read as the node it visits: iterations and items dropped. */
function address(path: string): string {
	return path.replace(/#\d+|\[\d+\]/g, "");
}

function isFail(answer: unknown): answer is { fail: unknown } {
	return typeof answer === "object" && answer !== null && !Array.isArray(answer) && Object.keys(answer).length === 1 && "fail" in answer;
}

/** Checked by the same `mismatch` a real submission passes. */
function checkAnswer(answer: unknown, node: CheckedAgentNode, at: string): AnswerFault | undefined {
	if (isFail(answer)) {
		if ((AGENT_FAILS as readonly unknown[]).includes(answer.fail)) return undefined;
		return { code: "answer-fail-kind", at, message: `an agent turn fails with ${AGENT_FAILS.join(", ")}, not ${JSON.stringify(answer.fail)}` };
	}
	const problem = mismatch(answer, node.output ?? TEXT);
	return problem === undefined ? undefined : { code: "answer-off-schema", at, message: problem };
}

function turn(answer: unknown, node: CheckedAgentNode): ScriptedTurn {
	if (isFail(answer)) return { fail: answer.fail as (typeof AGENT_FAILS)[number] };
	return node.output === undefined ? { say: answer as string } : { submit: submission(answer, node.output) };
}
