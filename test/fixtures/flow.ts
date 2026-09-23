/**
 * A checked flow written inline, and a `spawn` whose sessions can answer a
 * typed or a verdict node the way a model does: through the `submit` or the
 * `verdict` tool it was offered.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedCatalogue } from "../../scripts/flow-docs.ts";
import type { Agent } from "../../src/agent.ts";
import { checkFlow, checkRun, runFlow, type CheckedFlow, type CheckedRun, type DryRun, type FlowCatalogue, type FlowResult, type RunFlowOptions, type RunStage, type VisitEnd } from "../../src/flow/index.ts";
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
 * The text of the flow `name`: `head` lines after its name and description,
 * `nodes` under `nodes:`, and one section per entry of `sections`.
 */
export function flowText(nodes: string, sections: Record<string, string> = {}, head = "input: string", name = "f"): string {
	const body = Object.entries(sections).map(([id, prose]) => `## ${id}\n${prose}`).join("\n\n");
	return `---\nname: ${name}\ndescription: d\n${head}\nnodes:\n${nodes}\n---\n${body}`;
}

/** A catalogue holding `flows`, each text under its name, and {@link AGENTS}. */
export function catalogueOf(flows: Record<string, string>): FlowCatalogue {
	return { flows: Object.entries(flows).map(([name, content]) => ({ name, filePath: `flows/${name}.md`, content })), agents: AGENTS, brokenAgents: [], cwd: "." };
}

/** The flow `name` of {@link catalogueOf} `flows`, checked. */
export function checkedIn(name: string, flows: Record<string, string>): CheckedFlow {
	const result = checkFlow(name, catalogueOf(flows));
	assert.ok(result.ok, JSON.stringify(!result.ok && result.faults, null, 1));
	return result.flow;
}

/** The repository's root, where the package's own `flows/` and `agents/` are. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The flow `name` the package ships, checked against the agents it ships. */
export function shipped(name: string): CheckedFlow {
	const result = checkFlow(name, shippedCatalogue(ROOT));
	assert.ok(result.ok, JSON.stringify(!result.ok && result.faults, null, 1));
	return result.flow;
}

/** The faults of the flow `name` of {@link catalogueOf} `flows`, as `code at`. */
export function refusedIn(name: string, flows: Record<string, string>): string[] {
	const result = checkFlow(name, catalogueOf(flows));
	assert.ok(!result.ok, "expected the flow to be refused");
	return result.faults.map(({ code, at }) => `${code} ${at}`);
}

/** The flow `f` of {@link flowText}, checked. */
export function checked(nodes: string, sections: Record<string, string>, head = "input: string"): CheckedFlow {
	return checkedIn("f", { f: flowText(nodes, sections, head) });
}

/** The faults of the flow `f` whose nodes are `nodes` and whose body is `body`, as `code at`. */
export function refused(nodes: string, body = ""): string[] {
	return refusedIn("f", { f: `---\nname: f\ndescription: d\ninput: string\nnodes:\n${nodes}\n---\n${body}` });
}

/** The visits a dry run's journal holds, in the order they ended. */
export function visited(run: DryRun): VisitEnd[] {
	assert.ok("journal" in run, JSON.stringify(run));
	return run.journal.filter((entry) => entry.type === "visit_end");
}

/** `flow` through the run stage: in this directory, with no port and nobody there unless `stage` says otherwise. */
export async function launched(flow: CheckedFlow, stage: Partial<RunStage> = {}): Promise<CheckedRun> {
	const result = await checkRun(flow, { cwd: process.cwd(), ports: {}, somebodyThere: false, ...stage });
	assert.ok(result.ok, JSON.stringify(!result.ok && result.faults, null, 1));
	return result.run;
}

/** `runFlow` on `flow` {@link launched} as it is: what a flow of agents and blocks needs. */
export async function runChecked(flow: CheckedFlow, input: unknown, options?: RunFlowOptions): Promise<FlowResult> {
	return runFlow(await launched(flow), input, options);
}

/** A fake turn that may also call `submit` with `submit`, `verdict` with `verdict`, or `subagent` with `subagent`, before it ends. */
export type FlowTurn = Turn & { submit?: unknown; verdict?: unknown; subagent?: unknown };

/**
 * The real `spawn`, on fake sessions: the n-th subagent spawned plays the
 * n-th list of turns, or with a record, the n-th subagent of an agent plays
 * the n-th list under its name, which branches spawning at once need.
 * `requested` is what each spawn asked the session for. A session exports
 * its prompts as its JSONL, one per line, and a page naming its agent.
 */
export function flowSpawn(turnsPerSpawn: FlowTurn[][] | Record<string, FlowTurn[][]>): { spawn: SpawnFn; created: FakeSession[]; requested: { agent: Agent; options: CreateSessionOptions }[] } {
	const created: FakeSession[] = [];
	const requested: { agent: Agent; options: CreateSessionOptions }[] = [];
	const createSession: CreateSession = async (agent, options) => {
		const turns = (Array.isArray(turnsPerSpawn) ? turnsPerSpawn[created.length] : turnsPerSpawn[agent.name]?.[requested.filter((one) => one.agent.name === agent.name).length]) ?? [];
		const session = fakeSession(turns);
		const prompt = session.prompt.bind(session);
		let index = 0;
		session.prompt = async (text) => {
			const turn = turns[index++];
			for (const name of ["submit", "verdict", "subagent"] as const) {
				const tool = options.customTools?.find((one) => one.name === name);
				if (turn?.[name] !== undefined && tool !== undefined) await callTool(tool, turn[name]);
			}
			await prompt(text);
		};
		session.exportToJsonl = (file = "session.jsonl") => write(file, session.prompts.map((one) => `${JSON.stringify(one)}\n`).join(""));
		session.exportToHtml = async (file = "session.html") => write(file, `<p>${agent.name}</p>`);
		created.push(session);
		requested.push({ agent, options });
		return session;
	};
	return { spawn: (agent, options) => spawn(agent, { ...options, createSession }), created, requested };
}

/** Writes `content` to `file`, its directory made, and gives the path back as pi's exporters do. */
function write(file: string, content: string): string {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}
