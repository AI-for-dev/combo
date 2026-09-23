/**
 * What an `agent` visit is asked: the whole turn, composed by our code.
 *
 * The node's section, then each read under `## <address as written>`, then,
 * when the answer is a tool call, a closing part saying so: `submit` for a
 * typed node, and for a `verdict:` node the record's terms, which list the
 * ledger's open obligations by id. Every visit gets
 * the whole of it, with or without `memory:`, so a resumed run's fresh
 * subagent is asked what the first one was. The language line comes last, and
 * `Subagent.ask` adds it to every turn, this one included.
 */

import type { Ledger } from "../../review/index.ts";
import type { CheckedAgentNode, CheckedRead, FlowError } from "../checked.ts";
import type { Held } from "./frames.ts";
import { showRead } from "./reads.ts";
import { SUBMIT_TOOL } from "./submit.ts";
import type { Values } from "./values.ts";

/** The closing part of a node that answers with `submit`. */
const SUBMIT_CLOSING = `Answer by calling \`${SUBMIT_TOOL}\` with the value asked for above: the call is your answer, and text you write beside it is not read.`;

/** The whole turn of `node`, reading `values`, closed by `closing`. */
export function composeTurn(node: CheckedAgentNode, values: Values, closing: readonly string[]): string {
	const reads = node.reads.flatMap((read) => section(read, values));
	return [node.prose.trim(), ...reads, ...closing].join("\n\n");
}

/**
 * What a retry on the same subagent is asked: the failure, and the closing
 * part again. The turn itself is already in its history.
 */
export function retryTurn(error: FlowError, closing: readonly string[]): string {
	return [`Your last answer failed (${error.kind}: ${error.message}). Do the same task again.`, ...closing].join("\n\n");
}

/** The closing part of `node`'s turn on `held`, a `verdict:` node's writing to `ledger`. */
export function closingPart(node: CheckedAgentNode, held: Held, ledger: Ledger | undefined): string[] {
	if (ledger !== undefined && held.verdict !== undefined) return [held.verdict.terms(ledger)];
	return node.output === undefined ? [] : [SUBMIT_CLOSING];
}

/** One read as a section under `## <address>`, JSON in a fenced block. */
function section(read: CheckedRead, values: Values): string[] {
	const shown = showRead(read, values);
	if (shown === undefined) return [];
	const heading = `## ${shown.name}`;
	const body = shown.json ? `\`\`\`json\n${shown.body}\n\`\`\`` : shown.body;
	return [body === "" ? heading : `${heading}\n\n${body}`];
}
