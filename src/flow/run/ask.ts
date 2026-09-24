/**
 * One visit of an `ask` node: its question put to a person, and what not
 * answering gives.
 *
 * Not answering is a value wherever the file says what it is: `default:`
 * when nobody answers, there or in time, and `answered: false` when the card
 * offers "that's enough". Only a question that has neither fails, with
 * `nobody` or `timeout`. Declining a card that offers no "enough" is the
 * run's stop key, pressed on the card that holds it.
 */

import type { Answer, Asking, Question } from "../../ask.ts";
import { timedOutAfter } from "../../deadline.ts";
import type { GitResult } from "../../git/index.ts";
import { emptyUsage } from "../../usage.ts";
import type { CheckedAskNode } from "../checked.ts";
import { failure, interruption, type Ended, type Visited } from "./ended.ts";
import { showRead, withDiff } from "./reads.ts";
import type { Values } from "./values.ts";
import type { Here } from "./walk.ts";

/** A question as it goes to the person: the question, and how the card puts it. */
export type Card = { readonly question: Question; readonly asking: Omit<Asking, "signal"> };

/**
 * What the person's side gave: the node's output, the person declining the
 * card, or nobody answering, there or before the node's `timeout:`.
 */
export type Heard = { readonly output: unknown } | { readonly declined: true } | { readonly missed: "nobody" | "timeout" };

/** What an ask visit needs from the run around it. */
export type AskingRun = {
	/** The run's signal: aborted, nothing starts and nothing catches the failure. */
	readonly signal: AbortSignal;
	/** Puts `card` for the visit `path` of `node`; aborting `cut` takes it down. */
	ask(node: CheckedAskNode, path: string, card: Card, cut: AbortSignal): Promise<Heard>;
	/** What `tree` changed since `HEAD`, as `diff` reads it. */
	diff(tree: string | undefined): Promise<GitResult<string>>;
	/** Stops the whole run, as its stop key does. */
	stop(): void;
};

/** A choice card left with "that's enough", or with nobody there and no `default:`. */
const NOT_ANSWERED = { answered: false };

/** Visits `node` at `path`. A stop or a cut is read off the signals, never off what the person's side says. */
export async function visitAsk(run: AskingRun, node: CheckedAskNode, path: string, at: Here): Promise<Visited> {
	const end = (ended: Ended): Visited => ({ ended, usage: emptyUsage() });
	const question = questionOf(node, at.values);
	if (typeof question === "string") return end(failure("condition", question));
	const here = await withDiff((tree) => run.diff(tree), node.reads, at);
	if (typeof here === "string") return end(failure("unavailable", here));
	const context = node.reads.flatMap((read) => showRead(read, here.values) ?? []).map(({ name, body }) => ({ name, body }));
	const form = node.form === "choice" ? (node.options === undefined ? "open" : "closed") : node.form;
	const heard = await run.ask(node, path, { question, asking: { form, context, visit: path, enough: node.enough ?? false } }, AbortSignal.any([run.signal, here.cut]));
	const cut = interruption(run.signal, here.cut);
	if (cut !== undefined) return end({ ok: false, error: cut });
	if ("output" in heard) return end({ ok: true, output: heard.output });
	if ("missed" in heard) return end(unanswered(node, question, heard.missed));
	if (node.enough !== undefined) return end({ ok: true, output: NOT_ANSWERED });
	run.stop();
	return end(failure("stopped", "the run was stopped at this question"));
}

/** What `node` outputs once `answer` came back: a choice card's pick, a yes or no, or a free text. */
export function outputOf(node: CheckedAskNode, answer: Answer): unknown {
	if (node.form === "confirm") return { yes: answer.answer === "yes" };
	if (node.form === "text") return answer.answer;
	return { answered: true, answer: answer.answer, custom: answer.custom };
}

/** What nobody answering gives: the node's `default:`, else "not answered" on a card offering it, else a failure. */
function unanswered(node: CheckedAskNode, question: Question, kind: "nobody" | "timeout"): Ended {
	const given = node.default;
	if (given !== undefined) {
		const answer = typeof given === "boolean" ? (given ? "yes" : "no") : given;
		return { ok: true, output: outputOf(node, { question: question.question, answer, custom: !question.options.some((one) => one.label === given) }) };
	}
	if (node.enough !== undefined) return { ok: true, output: NOT_ANSWERED };
	const why = kind === "timeout" && node.timeoutMs !== undefined ? timedOutAfter(node.timeoutMs) : "nobody is there to answer";
	return failure(kind, `${why}, and the question has no \`default:\``);
}

/** The question a literal writes, or the `Question` an `ask-from:` reads; or why it could not be read. */
function questionOf(node: CheckedAskNode, values: Values): Question | string {
	if ("text" in node.question) return { question: node.question.text, options: [...(node.options ?? [])] };
	const read = values.need(node.question.from);
	return read.ok ? (read.value as Question) : `\`ask-from: ${node.question.from}\`: ${read.message}`;
}
