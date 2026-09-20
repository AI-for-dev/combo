/**
 * The constant parts of a tool combo defines: whether an agent asked for it,
 * and the two shapes of answer a model reads.
 *
 * Three tools - the verdict, the board, the subagent - each wrote these three
 * lines for themselves, once identically and twice inline. A tool body should
 * be the decision it records or the act it performs, and nothing else.
 */

/**
 * Whether an agent's `tools:` names `name`.
 *
 * The agent's file is the allowlist: pi enables a custom tool only when the
 * definition names it, so a tool is offered to whoever declares it and costs
 * nothing to offer otherwise. What an agent can do stays readable in its file.
 */
export function declares(tools: readonly string[] | undefined, name: string): boolean {
	return tools?.includes(name) ?? false;
}

/** An answer the model reads as an answer. */
export function said(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

/** A refusal the model can act on, rather than a failure it has to guess at. */
export function refuse(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}
