/**
 * Which agents a tool call loads when it names no scope, and what it hides.
 *
 * The tool loads what `/run` and `/step` load: the repository's agents beside
 * the user's and the shipped ones, the repository's winning a name. The person
 * working in a repository put its `.pi/agents/` there to be used, and a call
 * that ran another definition of the same name did so in silence.
 *
 * Winning a name hides the user's own definition of it, and that one was
 * written on purpose too. So a call whose agents shadow one in the user's
 * directory says so, with the scope that runs it.
 */

import path from "node:path";
import type { Agent, AgentScope } from "../src/index.ts";
import type { Params } from "./params.ts";

/** The scope of a call that names none. */
export const DEFAULT_SCOPE: AgentScope = "both";

/**
 * One line per project agent `params` names that hides one of `user`, or
 * `undefined` when it hides none. `roster` is what the call loaded.
 */
export function shadowWarning(params: Params, roster: Agent[], user: Agent[], cwd: string): string | undefined {
	const named = new Set([params.agent, params.reduceWith, ...(params.steps ?? []), ...(params.candidates ?? [])]);
	const lines = roster.flatMap((agent) => {
		const hidden = agent.source === "project" && named.has(agent.name) ? user.find((other) => other.source === "user" && other.name === agent.name) : undefined;
		if (!hidden) return [];
		return [`"${agent.name}" runs from ${path.relative(cwd, agent.filePath)}; ${hidden.filePath} defines another "${agent.name}", which scope "user" runs.`];
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}
