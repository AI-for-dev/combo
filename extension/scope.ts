/**
 * Which agents a tool call loads when it names no scope, and what it hides.
 *
 * The tool loads what `/run` and `/step` load: the repository's agents beside
 * the user's and the shipped ones, the repository's winning a name. The person
 * working in a repository put its `.pi/agents/` there to be used, and a call
 * that ran another definition of the same name did so in silence.
 *
 * Winning a name hides the user's own definition of it, and that one was
 * written on purpose too. So whatever runs agents from that roster, the tool
 * in any mode, `/run` or `/step`, says when one it runs shadows one in the
 * user's directory, with the scope that runs it.
 */

import path from "node:path";
import type { Agent, AgentScope } from "../src/index.ts";
import type { Ui } from "./pi.ts";
import type { Params } from "./params.ts";

/** The scope of a call that names none. */
export const DEFAULT_SCOPE: AgentScope = "both";

/**
 * One line per agent of `used` that comes from the repository and hides one of
 * `user`, or `undefined` when none does.
 */
function shadowWarning(used: readonly Agent[], user: readonly Agent[], cwd: string): string | undefined {
	const lines = used.flatMap((agent) => {
		const hidden = agent.source === "project" ? user.find((other) => other.source === "user" && other.name === agent.name) : undefined;
		if (!hidden) return [];
		return [`"${agent.name}" runs from ${path.relative(cwd, agent.filePath)}; ${hidden.filePath} defines another "${agent.name}", which scope "user" runs.`];
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * {@link shadowWarning} for what is about to run, said in pi as a warning and
 * returned for a caller that has a model to tell as well. The user's agents
 * are only read when a repository's agent is among `used`.
 */
export function warnShadows(used: readonly Agent[], ctx: { cwd: string; ui?: Partial<Pick<Ui, "notify">> }, load: (options: { cwd: string; scope: AgentScope }) => Agent[]): string | undefined {
	if (!used.some((agent) => agent.source === "project")) return undefined;
	const warning = shadowWarning(used, load({ cwd: ctx.cwd, scope: "user" }), ctx.cwd);
	if (warning) ctx.ui?.notify?.(warning, "warning");
	return warning;
}

/** `text` for the model, and the warning after it when there is one. */
export function warned(text: string, warning: string | undefined): string {
	return warning ? `${text}\n\nWarning: ${warning}` : text;
}

/** The agents a call of the tool names, among those it loaded. */
export function namedBy(params: Params, roster: readonly Agent[]): Agent[] {
	const named = new Set([params.agent, params.reduceWith, ...(params.steps ?? []), ...(params.candidates ?? [])]);
	return roster.filter((agent) => named.has(agent.name));
}
