/**
 * Checking an `ask`: what it reads, the `Question` an `ask-from:` takes, and
 * the output its form gives.
 *
 * Literal options make `answer` an enum, so a misspelt label in a `when:` is
 * refused before the first spawn. After `ask-from:`, the labels are a model's,
 * written in the person's language, so `answer` is a string no literal of the
 * file may be compared with: `"Yes"` against a clicked `"Oui"` would be
 * silently false.
 */

import type { Choice } from "../ask.ts";
import type { CheckedOne, Checker } from "./check.ts";
import type { CheckedAskNode } from "./checked.ts";
import type { AskNode } from "./node.ts";
import { QUESTION } from "./schema.ts";
import type { Scope } from "./scope.ts";
import { sameType, showType, type ValueType } from "./type.ts";

const BOOLEAN: ValueType = { kind: "boolean" };

/** `node`'s reads and question in `scope`, and what it outputs whether it passed or not. */
export function checkAsk(checker: Checker, node: AskNode, scope: Scope): CheckedOne {
	const output = askOutput(node);
	const before = checker.faults.list.length;
	const from = "from" in node.question ? node.question.from : undefined;
	const asked = from === undefined ? QUESTION : checker.typeOf(from, `${node.at}.ask-from`, scope);
	if (asked !== undefined && !sameType(asked, QUESTION)) checker.faults.add("key-type", `${node.at}.ask-from`, `\`${from}\` is ${showType(asked)}; \`ask-from:\` reads a \`Question\``);
	const reads = node.reads.map((address) => checker.read(address, `${node.at}.reads`, scope)).filter((read) => read !== undefined);
	if (asked === undefined || checker.faults.list.length > before) return { output };
	const { id, at, continueOnFail, question, form, options, enough, timeoutMs } = node;
	return { output, node: { kind: "ask", id, at, continueOnFail, question, form, options, enough, default: node.default, reads, timeoutMs, output } satisfies CheckedAskNode };
}

/**
 * What an `ask` outputs, by its form: a choice card `{ answered, answer?,
 * custom? }`, a yes or no `{ yes }`, a free text a string.
 */
function askOutput(node: AskNode): ValueType {
	if (node.form === "confirm") return { kind: "object", fields: { yes: { type: BOOLEAN, optional: false } } };
	if (node.form === "text") return { kind: "string" };
	return {
		kind: "object",
		fields: {
			answered: { type: BOOLEAN, optional: false },
			answer: { type: answerType(node.options), optional: true },
			custom: { type: BOOLEAN, optional: true },
		},
	};
}

/** Literal options' labels, strictly; or, taken from a `Question`, a string written by a model. */
function answerType(options: readonly Choice[] | undefined): ValueType {
	return options === undefined ? { kind: "string", free: true } : { kind: "enum", values: options.map((one) => one.label) };
}
