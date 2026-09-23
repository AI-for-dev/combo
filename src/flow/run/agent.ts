/**
 * One visit of an `agent` node: who runs it, the turn it is asked, and the
 * attempts `retry:` allows.
 *
 * A failed attempt is classified by our code, from what it knows rather than
 * from what a message says: the run's stop, a `fail-fast` cut, the subagent's
 * own stop, the deadline this attempt was given, and otherwise the provider.
 */

import type { Agent } from "../../agent.ts";
import type { GitResult } from "../../git/index.ts";
import type { Result } from "../../result.ts";
import type { Ledger } from "../../review/index.ts";
import { emptyUsage, sumUsage, type Usage } from "../../usage.ts";
import type { CheckedAgentNode, ErrorKind } from "../checked.ts";
import { failure, interruption, type Ended } from "./ended.ts";
import type { Held } from "./frames.ts";
import { withDiff } from "./reads.ts";
import { closingPart, composeTurn, retryTurn } from "./turn.ts";
import type { Here } from "./walk.ts";

/** The failures a `retry:` covers. A person's stop and a `fail-fast` cut are never retried. */
const RETRIED: readonly ErrorKind[] = ["schema", "provider", "timeout"];

/** One attempt about to be asked, as the run's deadline sees it: its visit, its node's address, its subagent. */
export type Attempt = { readonly path: string; readonly at: string; readonly subagent: string; readonly ms: number };

/** What an agent visit needs from the run around it. */
export type AgentRun = {
	/** The run's signal: aborted, nothing starts and nothing catches the failure. */
	readonly signal: AbortSignal;
	/** The bound of one attempt of `node`, in milliseconds. */
	timeoutFor(node: CheckedAgentNode): number;
	/** The deadline of one attempt. */
	deadline(attempt: Attempt): AbortSignal;
	/** A subagent of `agent` for `node`, spawned for the visit `path` in `tree`, with the tools it answers with. */
	open(agent: Agent, node: CheckedAgentNode, path: string, tree: string | undefined): Promise<Held>;
	/** What `tree` changed since `HEAD`, as `diff` reads it. */
	diff(tree: string | undefined): Promise<GitResult<string>>;
};

/** How an agent visit ended, with what it cost and who ran it. */
export type AgentVisit = { readonly ended: Ended; readonly usage: Usage; readonly agent?: string; readonly model?: string };

/** One visit's asking: its node and path, where it stands, and the ledger a `verdict:` node writes to. */
type Asking = { readonly run: AgentRun; readonly node: CheckedAgentNode; readonly path: string; readonly here: Here; readonly ledger?: Ledger };

/**
 * Visits `node` at `path`. A node with `memory:` resumes its scope's
 * subagent; any other gets a fresh one.
 */
export async function visitAgent(run: AgentRun, node: CheckedAgentNode, path: string, at: Here): Promise<AgentVisit> {
	const agent = pick(node, at);
	if (typeof agent === "string") return { ended: failure("condition", agent), usage: emptyUsage() };
	const here = await withDiff((tree) => run.diff(tree), node.reads, at);
	if (typeof here === "string") return { ended: failure("unavailable", here), usage: emptyUsage() };
	const asking: Asking = { run, node, path, here, ledger: node.verdict === undefined ? undefined : here.frames.ledger(node.verdict).by(path) };
	const open = () => run.open(agent, node, path, here.tree);
	if (node.memory !== undefined) return here.frames.use(node.memory, agent.name, open, (held) => attempts(asking, held));
	let held = await open();
	try {
		// A subagent cut by its deadline may be anywhere in its turn, so the
		// next attempt starts on a fresh one, asked the whole turn again.
		return await attempts(asking, held, async () => {
			await held.subagent.close();
			held = await open();
			return held;
		});
	} finally {
		await held.subagent.close();
	}
}

/**
 * Every attempt `retry:` allows on `held`. `renew` gives a fresh subagent
 * after a timeout; a scope's subagent has none, since a fresh one would break
 * the memory the scope is there for.
 */
async function attempts(asking: Asking, first: Held, renew?: () => Promise<Held>): Promise<AgentVisit> {
	const { node, here, ledger } = asking;
	const started = performance.now();
	const parts: Usage[] = [];
	let held = first;
	let task = composeTurn(node, here.values, closingPart(node, held, ledger));
	for (let attempt = 0; ; attempt++) {
		const { ended, usage } = await ask(asking, held, task);
		parts.push(usage);
		if (ended.ok || attempt >= node.retry || !RETRIED.includes(ended.error.kind)) {
			return { ended, usage: sumUsage(parts, performance.now() - started), agent: held.subagent.agent.name, model: held.subagent.model };
		}
		if (ended.error.kind === "timeout" && renew !== undefined) {
			held = await renew();
			task = composeTurn(node, here.values, closingPart(node, held, ledger));
		} else {
			task = retryTurn(ended.error, closingPart(node, held, ledger));
		}
	}
}

/** One attempt: the turn asked, then read as the node's output or the kind of its failure. */
async function ask({ run, node, path, here, ledger }: Asking, held: Held, task: string): Promise<{ ended: Ended; usage: Usage }> {
	const ms = run.timeoutFor(node);
	const deadline = run.deadline({ path, at: node.at, subagent: held.subagent.id, ms });
	const result = await held.subagent.ask(task, { signal: AbortSignal.any([here.cut, deadline]) });
	// Both are drained on every attempt, whichever the node reads: a shared
	// subagent's call during another node's turn must not stand in for a later one.
	const submitted = held.submit?.take();
	const decided = await held.verdict?.take(result, ledger);
	if (!result.ok) return { ended: failed(run, here.cut, result, deadline, ms), usage: result.usage };
	if (node.verdict === undefined && node.output === undefined) return { ended: { ok: true, output: result.output }, usage: result.usage };
	const answer = node.verdict === undefined ? submitted : decided;
	if (answer?.ok) return { ended: { ok: true, output: answer.value }, usage: result.usage };
	return { ended: failure("schema", answer?.message ?? "the turn ended with no `submit` call"), usage: result.usage };
}

function failed(run: AgentRun, cut: AbortSignal, result: Result, deadline: AbortSignal, ms: number): Ended {
	const cutShort = interruption(run.signal, cut);
	if (cutShort !== undefined) return { ok: false, error: cutShort };
	if (result.error === "stopped") return failure("stopped", "stopped");
	if (deadline.aborted) return failure("timeout", `no answer within ${ms} ms`);
	return failure("provider", result.error ?? "the turn failed");
}

/** The agent a node runs, or why the value that picks it could not be read. */
function pick(node: CheckedAgentNode, here: Here): Agent | string {
	if (!("from" in node.agent)) return node.agent;
	const { from, among } = node.agent;
	const read = here.values.need(from);
	return read.ok ? (among.get(read.value as string) as Agent) : `\`agent-from: ${from}\`: ${read.message}`;
}
