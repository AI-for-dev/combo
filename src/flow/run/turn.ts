/**
 * What an `agent` visit is asked: the whole turn, composed by our code.
 *
 * The node's section, then each read under `## <address as written>`, then,
 * when the answer is a tool call, a closing part saying so. Every visit gets
 * the whole of it, with or without `memory:`, so a resumed run's fresh
 * subagent is asked what the first one was. The language line comes last, and
 * `Subagent.ask` adds it to every turn, this one included.
 */

import type { CheckedAgentNode, CheckedRead, FlowError } from "../checked.ts";
import { SUBMIT_TOOL } from "./submit.ts";
import type { Values } from "./values.ts";

/** The closing part of a node that answers with `submit`. */
const SUBMIT_CLOSING = `Answer by calling \`${SUBMIT_TOOL}\` with the value asked for above: the call is your answer, and text you write beside it is not read.`;

/** The whole turn of `node`, reading `values`. */
export function composeTurn(node: CheckedAgentNode, values: Values): string {
	const reads = node.reads.flatMap((read) => section(read, values));
	return [node.prose.trim(), ...reads, ...closing(node)].join("\n\n");
}

/**
 * What a retry on the same subagent is asked: the failure, and the closing
 * part again. The turn itself is already in its history.
 */
export function retryTurn(node: CheckedAgentNode, error: FlowError): string {
	return [`Your last answer failed (${error.kind}: ${error.message}). Do the same task again.`, ...closing(node)].join("\n\n");
}

function closing(node: CheckedAgentNode): string[] {
	return node.output === undefined ? [] : [SUBMIT_CLOSING];
}

/**
 * One read as a section. Text, and a value typed `string`, goes as it is:
 * `input: string` is what a person typed, and a JSON string with its quotes
 * and escaped newlines would change how a model reads it. Any other value is
 * JSON, and so is a node that failed, the shape a block's failed branch has.
 */
function section(read: CheckedRead, values: Values): string[] {
	const heading = `## ${read.address}`;
	const reading = values.read(read.address);
	switch (reading.kind) {
		case "failed":
			return [`${heading}\n\n${json(reading.ended)}`];
		case "absent":
			// An optional field left out: the address still gets its section, as
			// an empty text does, and the runner writes no "(empty)" of its own.
			return [heading];
		case "value": {
			const plain = typeof reading.value === "string" && (read.type.kind === "text" || read.type.kind === "string");
			const body = plain ? (reading.value as string).trim() : json(reading.value);
			return [body === "" ? heading : `${heading}\n\n${body}`];
		}
	}
}

function json(value: unknown): string {
	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
