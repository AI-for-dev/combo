/**
 * Walking a checked flow: a sequence node after node, each visit announced on
 * the event stream, and a failure travelling up until a node absorbs it.
 *
 * Our code decides what runs next. A model's output is a value a `choice`
 * reads; it never names a node. The blocks that open branches are in
 * `blocks.ts` and `choice.ts`, the loop in `loop.ts`, and each comes back
 * through {@link Run.sequence}.
 */

import type { Agent } from "../../agent.ts";
import type { EventBus } from "../../events.ts";
import type { GitResult } from "../../git/index.ts";
import { VERDICT_TOOL } from "../../review/index.ts";
import { toolsOf } from "../../session.ts";
import { sumUsage, type Usage } from "../../usage.ts";
import type { ScriptOutcome } from "../../verify.ts";
import type { SpawnFn } from "../../workflows/options.ts";
import { type CheckedAgentNode, type CheckedAskNode, type CheckedCheckNode, type CheckedCommitNode, type CheckedFlow, type CheckedNode, type FlowError } from "../checked.ts";
import { sharedKey, sharedSubagents, submitted } from "../memory.ts";
import { visitAgent, type AgentRun, type Attempt } from "./agent.ts";
import { visitAsk, type AskingRun, type Card, type Heard } from "./ask.ts";
import { visitMap, visitParallel } from "./blocks.ts";
import { visitCheck, type CheckingRun } from "./check.ts";
import { visitChoice } from "./choice.ts";
import { visitCommit, type CommitOutcome, type CommittingRun } from "./commit.ts";
import type { Copies } from "./copies.ts";
import { interruption, under, type Ended, type Visited, type Walked } from "./ended.ts";
import type { Frames, Held } from "./frames.ts";
import { visitLoop } from "./loop.ts";
import { SUBMIT_TOOL, submitTool } from "./submit.ts";
import type { Values } from "./values.ts";
import { verdictSlot } from "./verdict.ts";

/** An agent turn's bound when neither the node, nor the flow, nor the caller sets one. */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Where a visit stands: what it reads, the memory scopes open around it, the
 * signal that cuts it short, the run's own or a `fail-fast` block's, and the
 * working tree it acts in: the run's, or its branch's copy inside a
 * `copies: true` block. A dry run has none.
 */
export type Here = { readonly values: Values; readonly frames: Frames; readonly cut: AbortSignal; readonly tree: string | undefined };

/** What a block needs of the walk: the run's signal, the copies it makes, and a sequence walked inside it. */
export type Walker = {
	readonly signal: AbortSignal;
	readonly copies?: Copies;
	sequence(nodes: readonly CheckedNode[], prefix: string, here: Here): Promise<Walked>;
};

/**
 * How a walk reaches the world: the deadline of each agent attempt, a
 * check's script run in a tree, a commit, the `diff` of a tree, the copies of
 * a block, and a question put to the person. A real run's come from its
 * `CheckedRun`; a dry run's are scripted, and it makes no copy.
 */
export type World = {
	deadline(attempt: Attempt): AbortSignal;
	check(node: CheckedCheckNode, path: string, signal: AbortSignal, tree: string | undefined): Promise<ScriptOutcome>;
	commit(node: CheckedCommitNode, path: string, message: string): Promise<CommitOutcome>;
	diff(tree: string | undefined): Promise<GitResult<string>>;
	ask(node: CheckedAskNode, path: string, card: Card, cut: AbortSignal): Promise<Heard>;
	readonly copies?: Copies;
};

/** What a run is given: the flow, its settings, and how it reaches the world. */
export type Walk = World & {
	readonly flow: CheckedFlow;
	readonly bus: EventBus;
	readonly signal: AbortSignal;
	readonly spawn: SpawnFn;
	readonly model?: string;
	readonly timeoutMs?: number;
	/** Aborts `signal`: the stop key, pressed on a card that offers no "enough". */
	stop(): void;
};

/** One run of a checked flow. */
export class Run implements AgentRun, AskingRun, CheckingRun, CommittingRun, Walker {
	readonly signal: AbortSignal;
	readonly copies?: Copies;
	private readonly walk: Walk;
	private readonly shared: ReturnType<typeof sharedSubagents>;

	constructor(walk: Walk) {
		this.walk = walk;
		this.signal = walk.signal;
		this.copies = walk.copies;
		this.shared = sharedSubagents(walk.flow.nodes);
	}

	/** `nodes` in order, inside the visit `prefix`. A failure not absorbed ends the sequence there. */
	async sequence(nodes: readonly CheckedNode[], prefix: string, here: Here): Promise<Walked> {
		const usage: Usage[] = [];
		let last: Ended | undefined;
		for (const node of nodes) {
			const path = under(prefix, node.id);
			const cut = interruption(this.signal, here.cut);
			if (cut !== undefined) return { last, usage, failed: { path, error: cut } };
			const visit = await this.visit(node, path, here);
			here.values.end(node.id, visit.ended);
			usage.push(visit.usage);
			last = visit.ended;
			// A stop and a cut are caught by nothing, `on-fail: continue` included.
			if (!visit.ended.ok && (!node.continueOnFail || here.cut.aborted)) return { last, usage, failed: visit.failed };
		}
		return { last, usage };
	}

	timeoutFor(node: CheckedAgentNode): number {
		return this.walk.timeoutMs ?? node.timeoutMs ?? this.walk.flow.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	deadline(attempt: Attempt): AbortSignal {
		return this.walk.deadline(attempt);
	}

	check(node: CheckedCheckNode, path: string, signal: AbortSignal, tree: string | undefined): Promise<ScriptOutcome> {
		return this.walk.check(node, path, signal, tree);
	}

	commit(node: CheckedCommitNode, path: string, message: string): Promise<CommitOutcome> {
		return this.walk.commit(node, path, message);
	}

	diff(tree: string | undefined): Promise<GitResult<string>> {
		return this.walk.diff(tree);
	}

	ask(node: CheckedAskNode, path: string, card: Card, cut: AbortSignal): Promise<Heard> {
		return this.walk.ask(node, path, card, cut);
	}

	stop(): void {
		this.walk.stop();
	}

	/**
	 * A subagent with the tools every node it serves answers with: one node
	 * without `memory:`, every node sharing it with one. The flow asked for a
	 * typed value or a verdict, so the agent is given the tool that hands it
	 * back; `tools:` is an allowlist, and it covers ours too.
	 */
	async open(agent: Agent, node: CheckedAgentNode, path: string, tree: string | undefined): Promise<Held> {
		const serves = node.memory === undefined ? [node] : (this.shared.get(sharedKey(node.memory, agent.name)) ?? []);
		const type = submitted(serves);
		const submit = type === undefined ? undefined : submitTool(type);
		const decides = serves.some((one) => one.verdict !== undefined);
		const added = [...(submit === undefined ? [] : [SUBMIT_TOOL]), ...(decides ? [VERDICT_TOOL] : [])];
		const holder = { ...agent, tools: added.length === 0 ? agent.tools : [...toolsOf(agent), ...added] };
		const verdict = decides ? verdictSlot(holder) : undefined;
		const subagent = await this.walk.spawn(holder, {
			lifetime: node.memory === undefined ? "task" : "workflow",
			bus: this.walk.bus,
			cwd: tree,
			// The run's, then the flow's; `spawn` falls back on the agent's own.
			model: this.walk.model ?? this.walk.flow.model,
			customTools: [submit?.tool, verdict?.tool].filter((tool) => tool !== undefined),
			visit: path,
		});
		return { subagent, submit, verdict };
	}

	/** One visit, between its `visit_start` and its `visit_end`. */
	private async visit(node: CheckedNode, path: string, here: Here): Promise<Visited> {
		const { bus } = this.walk;
		bus.emit({ type: "visit_start", path, node: node.at, kind: node.kind });
		const started = performance.now();
		const visit = await this.dispatch(node, path, here);
		const wallMs = performance.now() - started;
		const usage = { ...visit.usage, wallMs };
		const { ended, agent, model } = visit;
		bus.emit({ type: "visit_end", path, ok: ended.ok, ...told(node, ended), ...(agent !== undefined && { agent }), ...(model !== undefined && { model }), wallMs, usage });
		return { ended, usage, failed: visit.failed ?? (ended.ok ? undefined : { path, error: ended.error }) };
	}

	private async dispatch(node: CheckedNode, path: string, here: Here): Promise<Visited> {
		switch (node.kind) {
			case "agent":
				return visitAgent(this, node, path, here);
			case "choice":
				return visitChoice(this, node, path, here);
			case "parallel":
				return visitParallel(this, node, path, here);
			case "map":
				return visitMap(this, node, path, here);
			case "loop":
				return visitLoop(this, node, path, here);
			case "check":
				return visitCheck(this, node, path, here);
			case "commit":
				return visitCommit(this, node, path, here);
			case "ask":
				return visitAsk(this, node, path, here);
		}
	}
}

/** What a `visit_end` says of how `node` ended: its output, the case a `choice` ran, whether a `loop` converged; or why it failed. */
function told(node: CheckedNode, ended: Ended): { output?: unknown; case?: string; converged?: boolean; error?: FlowError } {
	if (!ended.ok) return { error: ended.error };
	const output = ended.output as { case?: string; converged?: boolean };
	if (node.kind === "choice") return { output, case: output.case };
	if (node.kind === "loop") return { output, converged: output.converged };
	return { output: ended.output };
}
