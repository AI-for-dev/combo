/**
 * One visit of an `agent` node: who runs it, the turn it is asked, and the
 * attempts `retry:` allows.
 *
 * A failed attempt is classified by our code, from what it knows rather than
 * from what a message says: the run's stop, the subagent's own stop, the
 * deadline this attempt was given, and otherwise the provider.
 */

import type { Agent } from "../../agent.ts";
import type { Result } from "../../result.ts";
import { sumUsage, type Usage } from "../../usage.ts";
import type { CheckedAgentNode, ErrorKind } from "../checked.ts";
import { failure, type Ended } from "./ended.ts";
import type { Frames, Held } from "./frames.ts";
import { composeTurn, retryTurn } from "./turn.ts";
import type { Values } from "./values.ts";

/** The failures a `retry:` covers. A person's stop and a `fail-fast` cut are never retried. */
const RETRIED: readonly ErrorKind[] = ["schema", "provider", "timeout"];

/** One attempt about to be asked, as the run's deadline sees it. */
export type Attempt = { readonly path: string; readonly subagent: string; readonly ms: number };

/** What an agent visit needs from the run around it. */
export type AgentRun = {
	/** The run's signal: aborted, nothing starts and nothing catches the failure. */
	readonly signal: AbortSignal;
	/** The bound of one attempt of `node`, in milliseconds. */
	timeoutFor(node: CheckedAgentNode): number;
	/** The deadline of one attempt. */
	deadline(attempt: Attempt): AbortSignal;
	/** A subagent of `agent` for `node`, with the `submit` tool it answers with. */
	open(agent: Agent, node: CheckedAgentNode): Promise<Held>;
};

/** How an agent visit ended, with what it cost and who ran it. */
export type AgentVisit = { readonly ended: Ended; readonly usage: Usage; readonly agent?: string; readonly model?: string };

/** Visits `node` at `path`. A node with `memory:` resumes its scope's subagent; any other gets a fresh one. */
export async function visitAgent(run: AgentRun, node: CheckedAgentNode, path: string, values: Values, frames: Frames): Promise<AgentVisit> {
	const started = performance.now();
	const parts: Usage[] = [];
	const done = (ended: Ended, held?: Held): AgentVisit => ({
		ended,
		usage: sumUsage(parts, performance.now() - started),
		agent: held?.subagent.agent.name,
		model: held?.subagent.model,
	});

	const agent = pick(node, values);
	if (typeof agent === "string") return done(failure("condition", agent));
	const scope = node.memory;
	const open = () => run.open(agent, node);
	let held = scope === undefined ? await open() : await frames.held(scope, agent.name, open);
	let task = composeTurn(node, values);
	try {
		for (let attempt = 0; ; attempt++) {
			const { ended, usage } = await ask(run, node, path, held, task);
			parts.push(usage);
			if (ended.ok || attempt >= node.retry || !RETRIED.includes(ended.error.kind)) return done(ended, held);
			// A subagent cut by its deadline may be anywhere in its turn, so the
			// next attempt starts fresh, unless a scope keeps it: a fresh one
			// would break the memory the scope is there for.
			if (ended.error.kind === "timeout" && scope === undefined) {
				await held.subagent.close();
				held = await open();
				task = composeTurn(node, values);
			} else {
				task = retryTurn(node, ended.error);
			}
		}
	} finally {
		if (scope === undefined) await held.subagent.close();
	}
}

/** One attempt: the turn asked, then read as the node's output or the kind of its failure. */
async function ask(run: AgentRun, node: CheckedAgentNode, path: string, held: Held, task: string): Promise<{ ended: Ended; usage: Usage }> {
	const ms = run.timeoutFor(node);
	const deadline = run.deadline({ path, subagent: held.subagent.id, ms });
	const result = await held.subagent.ask(task, { signal: AbortSignal.any([run.signal, deadline]) });
	// Taken on every attempt, typed or not: a shared subagent's call during an
	// untyped turn must not stand in for a later typed one.
	const submitted = held.submit?.take();
	if (!result.ok) return { ended: failed(run, result, deadline, ms), usage: result.usage };
	if (node.output === undefined) return { ended: { ok: true, output: result.output }, usage: result.usage };
	if (submitted?.ok) return { ended: { ok: true, output: submitted.value }, usage: result.usage };
	return { ended: failure("schema", submitted?.message ?? "the turn ended with no `submit` call"), usage: result.usage };
}

function failed(run: AgentRun, result: Result, deadline: AbortSignal, ms: number): Ended {
	if (run.signal.aborted) return failure("stopped", "the run was stopped");
	if (result.error === "stopped") return failure("stopped", "stopped");
	if (deadline.aborted) return failure("timeout", `no answer within ${ms} ms`);
	return failure("provider", result.error ?? "the turn failed");
}

/** The agent a node runs, or why the value that picks it could not be read. */
function pick(node: CheckedAgentNode, values: Values): Agent | string {
	if (!("from" in node.agent)) return node.agent;
	const { from, among } = node.agent;
	const reading = values.read(from);
	if (reading.kind === "value") return among.get(reading.value as string) as Agent;
	return `\`agent-from: ${from}\`: ${reading.kind === "failed" ? `\`${from.split(".")[0]}\` failed` : reading.message}`;
}
