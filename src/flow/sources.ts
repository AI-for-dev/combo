/**
 * What the flow stage read to check a flow: its file and the file of every
 * flow it reaches, and each agent it names with the skills that agent's
 * `skills:` resolved to.
 *
 * A checked flow carries it so that a run can keep a copy of exactly that:
 * what it runs is what validation read, whatever the disk says later.
 */

import type { Agent } from "../agent.ts";
import type { MarkdownFile } from "../markdown.ts";
import type { Skill } from "../skills.ts";
import type { CheckedNode } from "./checked.ts";
import { everyNode } from "./node.ts";

/** An agent a flow names, and the skills its `skills:` resolved to, in the order it names them. */
export type NamedAgent = { readonly agent: Agent; readonly skills: readonly Skill[] };

/** Everything a flow's check read, each file and each agent once. */
export type Sources = { readonly flows: readonly MarkdownFile[]; readonly agents: readonly NamedAgent[] };

/**
 * The sources of the flow in `file` whose checked nodes are `nodes`: its own,
 * then each callee's, which its checked flow already holds.
 */
export function sourcesOf(file: MarkdownFile, nodes: readonly CheckedNode[], skillsOf: (agent: Agent) => readonly Skill[]): Sources {
	const flows = new Map([[file.name, file]]);
	const agents = new Map<string, NamedAgent>();
	for (const node of everyNode(nodes)) {
		if (node.kind === "agent") {
			for (const agent of "from" in node.agent ? node.agent.among.values() : [node.agent]) agents.set(agent.name, { agent, skills: skillsOf(agent) });
		} else if (node.kind === "flow") {
			for (const flow of node.callee.sources.flows) flows.set(flow.name, flow);
			for (const named of node.callee.sources.agents) agents.set(named.agent.name, named);
		}
	}
	return { flows: [...flows.values()], agents: [...agents.values()] };
}
