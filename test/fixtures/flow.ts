/**
 * A checked flow written inline, and a `spawn` whose sessions can answer a
 * typed node the way a model does: through the `submit` tool it was offered.
 */

import assert from "node:assert/strict";
import type { Agent } from "../../src/agent.ts";
import { checkFlow, type CheckedFlow } from "../../src/flow/index.ts";
import type { CreateSession, CreateSessionOptions } from "../../src/session.ts";
import { spawn } from "../../src/subagent.ts";
import type { SpawnFn } from "../../src/workflows/options.ts";
import { callTool } from "./call-tool.ts";
import { fakeSession, type FakeSession, type Turn } from "./fake-session.ts";

export function agent(name: string, tools?: string[]): Agent {
	return { name, description: `the ${name}`, systemPrompt: `You are the ${name}.`, tools, source: "builtin", filePath: `agents/${name}.md` };
}

export const AGENTS = ["scout", "planner", "reviewer", "synthesiser"].map((name) => agent(name));

/**
 * The flow `f`: `head` lines after its name and description, `nodes` under
 * `nodes:`, and one section per entry of `sections`.
 */
export function checked(nodes: string, sections: Record<string, string>, head = "input: string"): CheckedFlow {
	const body = Object.entries(sections).map(([id, prose]) => `## ${id}\n${prose}`).join("\n\n");
	const content = `---\nname: f\ndescription: d\n${head}\nnodes:\n${nodes}\n---\n${body}`;
	const result = checkFlow("f", { flows: [{ name: "f", filePath: "flows/f.md", content }], agents: AGENTS, brokenAgents: [], cwd: "." });
	assert.ok(result.ok, JSON.stringify(!result.ok && result.faults, null, 1));
	return result.flow;
}

/** A fake turn that may also call `submit` with `submit`, before it ends. */
export type FlowTurn = Turn & { submit?: unknown };

/**
 * The real `spawn`, on fake sessions: the n-th subagent spawned plays the
 * n-th list of turns. `requested` is what each spawn asked the session for.
 */
export function flowSpawn(turnsPerSpawn: FlowTurn[][]): { spawn: SpawnFn; created: FakeSession[]; requested: { agent: Agent; options: CreateSessionOptions }[] } {
	const created: FakeSession[] = [];
	const requested: { agent: Agent; options: CreateSessionOptions }[] = [];
	const createSession: CreateSession = async (agent, options) => {
		const turns = turnsPerSpawn[created.length] ?? [];
		const session = fakeSession(turns);
		const prompt = session.prompt.bind(session);
		let index = 0;
		session.prompt = async (text) => {
			const turn = turns[index++];
			const submit = options.customTools?.find((tool) => tool.name === "submit");
			if (turn?.submit !== undefined && submit !== undefined) await callTool(submit, turn.submit);
			await prompt(text);
		};
		created.push(session);
		requested.push({ agent, options });
		return session;
	};
	return { spawn: (agent, options) => spawn(agent, { ...options, createSession }), created, requested };
}
