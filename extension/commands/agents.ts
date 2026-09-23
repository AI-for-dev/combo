/**
 * `/agents`: what can be spawned here, and where each definition came from.
 *
 * The same failure `/flows` answers for flows: an agent that lives in one
 * repository is invisible from another, and until now the only way to find out
 * what was loaded was to mistype a name and read the error. Scope is half the
 * answer, so it is what the listing is built around - three sources, most
 * specific first, each with the directory it was read from.
 */

import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Agent, AgentSource } from "../../src/index.ts";
import { loadRoster } from "../command.ts";
import type { CommandCtx, PiApi } from "../pi.ts";
import { resolved, type CommandDeps } from "../deps.ts";

/**
 * The three sources, most specific first, and where each would be read from.
 *
 * The fallback only shows when a source turned up nothing: a source that has
 * agents names the directory they actually came from, which is not the same
 * path - `.pi/agents/` is found by walking up, and may sit in an ancestor.
 */
const SOURCES: { source: AgentSource; where: (cwd: string) => string }[] = [
	{ source: "project", where: (cwd) => path.join(cwd, CONFIG_DIR_NAME, "agents") },
	{ source: "user", where: () => path.join(getAgentDir(), "agents") },
	{ source: "builtin", where: () => "shipped with combo" },
];

/** One source, with what it contributed to the roster. */
export type AgentGroup = { source: AgentSource; where: string; agents: Agent[] };

/** Registers `/agents`. */
export default function registerAgentCommands(pi: PiApi) {
	pi.registerCommand("agents", {
		description: "List the agents that can be spawned, and where they come from",
		handler: async (_args, ctx: CommandCtx) => {
			listAgents(ctx);
		},
	});
}

/**
 * The roster split by source, in precedence order.
 *
 * A name defined twice appears once: `loadAgents` already applied precedence,
 * and the group it lands in is the one that won it. That is the point of
 * showing the source at all.
 */
export function groupAgents(agents: Agent[], cwd: string): AgentGroup[] {
	return SOURCES.map(({ source, where }) => {
		const mine = agents.filter((agent) => agent.source === source).sort((a, b) => a.name.localeCompare(b.name));
		return { source, where: mine[0] ? path.dirname(mine[0].filePath) : where(cwd), agents: mine };
	});
}

/**
 * The listing, as lines.
 *
 * Kept away from the terminal so it can be asserted on directly, the same split
 * as `/flows` and the run picture.
 */
export function agentLines(agents: Agent[], cwd: string): string[] {
	const groups = groupAgents(agents, cwd);
	const width = Math.max(...agents.map((agent) => agent.name.length), 0);

	const lines: string[] = [];
	for (const group of groups) {
		lines.push(`${group.source} · ${group.where}`);
		if (group.agents.length === 0) lines.push("  (none)");
		for (const agent of group.agents) {
			lines.push(`  ${agent.name.padEnd(width)}  ${agent.description}`);
		}
	}

	// Only when there is something to miss: the subagent tool reads the shipped
	// and the user's agents, and a repository's only when it is asked to.
	if (groups[0]?.agents.length) {
		lines.push("");
		lines.push('A project agent needs scope "project" or "both" from the subagent tool. /run and /build load all three.');
	}
	return lines;
}

/** `/agents` - what is loaded, and from where. */
export function listAgents(ctx: CommandCtx, deps: CommandDeps = {}): string[] {
	const lines = agentLines(loadRoster(ctx, resolved(deps)), ctx.cwd);
	ctx.ui.notify(lines.join("\n"), "info");
	return lines;
}
