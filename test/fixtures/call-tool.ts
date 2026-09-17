/**
 * Calling a tool the way pi would.
 *
 * A `ToolDefinition.execute` is typed against the schema it was built with, and
 * a test holds the tool as the erased `ToolDefinition` a workflow passes around.
 * The cast lives here once rather than in every test that drives a tool.
 */

import type { ToolDefinition } from "../../src/session.ts";

type Execute = (
	toolCallId: string,
	params: unknown,
	signal: undefined,
	onUpdate: undefined,
	ctx: unknown,
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

/** Runs `tool` with `params`, as pi does once a model has asked for it. */
export function callTool(tool: ToolDefinition, params: unknown) {
	return (tool.execute as unknown as Execute)("test-call", params, undefined, undefined, {});
}
