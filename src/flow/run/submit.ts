/**
 * The `submit` tool: how a node with `output:` answers.
 *
 * A typed value is never parsed out of prose. The node's schema is published
 * as the tool's parameters, a call is checked against the same type by
 * `mismatch`, and what the node outputs is the call, not the text around it.
 * A call that does not match is refused back to the model, which can call
 * again within the same turn; a turn that ends with no accepted call fails
 * the node with `schema`.
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../../session.ts";
import { refuse, said } from "../../tool.ts";
import { mismatch, type ValueType } from "../type.ts";

/** The tool's name, which the runner adds to the agent's `tools:` for a typed node. */
export const SUBMIT_TOOL = "submit";

/** A value a tool call can carry is an object, so any other type travels in `value`. */
const WRAPPER = "value";

/** What a turn submitted: the value accepted, or why the last call was refused. */
export type Submission = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

/** The tool, and what was submitted through it since the last `take()`. */
export type SubmitTool = {
	readonly tool: ToolDefinition;
	/** The last value accepted, else the last refusal, else `undefined`; and forgets them. */
	take(): Submission | undefined;
};

/** A `submit` tool for values of `type`. One per subagent: the collector is how the value gets back. */
export function submitTool(type: ValueType): SubmitTool {
	const wrapped = type.kind !== "object";
	let accepted: Submission | undefined;
	let refused: Submission | undefined;
	const tool = defineTool({
		name: SUBMIT_TOOL,
		label: "Submit",
		description: "Submit your answer. The call is the answer: text you write beside it is not read. A call that does not match the schema is refused with the reason, and you can call again.",
		promptSnippet: "Submit your answer as the value asked for",
		parameters: Type.Unsafe<Record<string, unknown>>(parameters(type, wrapped) as never),
		async execute(_toolCallId, params) {
			const value = wrapped ? (params as Record<string, unknown>)[WRAPPER] : params;
			const problem = mismatch(value, type);
			if (problem !== undefined) {
				refused = { ok: false, message: problem };
				return refuse(`Not submitted: ${problem}. Call \`${SUBMIT_TOOL}\` again with a value of the schema.`);
			}
			accepted = { ok: true, value };
			return said("Submitted.");
		},
	});
	return {
		tool,
		take() {
			const taken = accepted ?? refused;
			accepted = refused = undefined;
			return taken;
		},
	};
}

/** What a call to the tool carries for `value` of `type`: the value itself, or `{ value }`. */
export function submission(value: unknown, type: ValueType): unknown {
	return type.kind === "object" ? value : { [WRAPPER]: value };
}

function parameters(type: ValueType, wrapped: boolean): Record<string, unknown> {
	return wrapped ? { type: "object", properties: { [WRAPPER]: jsonSchema(type) }, required: [WRAPPER], additionalProperties: false } : jsonSchema(type);
}

/** `type` as the JSON Schema a provider reads, descriptions kept for the model filling it. */
export function jsonSchema(type: ValueType): Record<string, unknown> {
	const described = type.description === undefined ? {} : { description: type.description };
	switch (type.kind) {
		case "text":
		case "string":
			return { type: "string", ...described };
		case "number":
		case "boolean":
			return { type: type.kind, ...described };
		case "enum":
			return { type: "string", enum: [...type.values], ...described };
		case "list":
			return { type: "array", items: jsonSchema(type.of), ...described };
		case "object": {
			const fields = Object.entries(type.fields);
			return {
				type: "object",
				properties: Object.fromEntries(fields.map(([name, field]) => [name, jsonSchema(field.type)])),
				required: fields.filter(([, field]) => !field.optional).map(([name]) => name),
				additionalProperties: false,
				...described,
			};
		}
	}
}
