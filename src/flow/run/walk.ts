/**
 * Walking a checked flow: a sequence node after node, each visit announced on
 * the event stream, and a failure travelling up until a node absorbs it.
 *
 * Our code decides what runs next. A model's output is a value a `choice`
 * reads; it never names a node. The blocks that open branches are in
 * `blocks.ts`, the loop in `loop.ts`, and both come back through
 * {@link Run.sequence}.
 */

import type { Agent } from "../../agent.ts";
import type { EventBus } from "../../events.ts";
import { VERDICT_TOOL } from "../../review/index.ts";
import { toolsOf } from "../../session.ts";
import { emptyUsage, sumUsage, type Usage } from "../../usage.ts";
import type { SpawnFn } from "../../workflows/options.ts";
import { caseNames, type CheckedAgentNode, type CheckedChoiceNode, type CheckedFlow, type CheckedNode, type FlowError } from "../checked.ts";
import { evaluateCondition } from "../condition/index.ts";
import { sharedKey, sharedSubagents, submitted } from "../memory.ts";
import { visitAgent, type AgentRun, type Attempt } from "./agent.ts";
import { visitMap, visitParallel } from "./blocks.ts";
import { failure, interruption, travelled, under, type Ended, type Visited, type Walked } from "./ended.ts";
import type { Frames, Held } from "./frames.ts";
import { visitLoop } from "./loop.ts";
import { SUBMIT_TOOL, submitTool } from "./submit.ts";
import type { Values } from "./values.ts";
import { verdictSlot } from "./verdict.ts";

/** An agent turn's bound when neither the node, nor the flow, nor the caller sets one. */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Where a visit stands: what it reads, the memory scopes open around it, and
 * the signal that cuts it short, the run's own or a `fail-fast` block's.
 */
export type Here = { readonly values: Values; readonly frames: Frames; readonly cut: AbortSignal };

/** What a block needs of the walk: the run's signal, and a sequence walked inside it. */
export type Walker = { readonly signal: AbortSignal; sequence(nodes: readonly CheckedNode[], prefix: string, here: Here): Promise<Walked> };

/** What a run is given: the flow, and how it reaches the world. */
export type Walk = {
	readonly flow: CheckedFlow;
	readonly bus: EventBus;
	readonly signal: AbortSignal;
	readonly spawn: SpawnFn;
	readonly model?: string;
	readonly timeoutMs?: number;
	readonly cwd?: string;
	readonly deadline: (attempt: Attempt) => AbortSignal;
};

/** One run of a checked flow. */
export class Run implements AgentRun, Walker {
	readonly signal: AbortSignal;
	private readonly walk: Walk;
	private readonly shared: ReturnType<typeof sharedSubagents>;

	constructor(walk: Walk) {
		this.walk = walk;
		this.signal = walk.signal;
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

	/**
	 * A subagent with the tools every node it serves answers with: one node
	 * without `memory:`, every node sharing it with one. The flow asked for a
	 * typed value or a verdict, so the agent is given the tool that hands it
	 * back; `tools:` is an allowlist, and it covers ours too.
	 */
	async open(agent: Agent, node: CheckedAgentNode, path: string): Promise<Held> {
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
			cwd: this.walk.cwd,
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
				return this.choice(node, path, here);
			case "parallel":
				return visitParallel(this, node, path, here);
			case "map":
				return visitMap(this, node, path, here);
			case "loop":
				return visitLoop(this, node, path, here);
		}
	}

	/** The first case whose condition holds, else the default, in a scope of its own. */
	private async choice(node: CheckedChoiceNode, path: string, here: Here): Promise<Visited> {
		const names = caseNames(node.cases.length);
		let chosen = node.cases.length;
		for (const [index, one] of node.cases.entries()) {
			const holds = evaluateCondition(one.when, here.values.all());
			if (!holds.ok) return { ended: failure("condition", `\`${one.when.source.trim()}\`: ${holds.message}`), usage: emptyUsage() };
			if (holds.value) {
				chosen = index;
				break;
			}
		}
		const frames = here.frames.inside(node.id);
		let walked: Walked;
		try {
			walked = await this.sequence(node.cases[chosen]?.nodes ?? node.otherwise, path, { ...here, values: here.values.inside(), frames });
		} finally {
			await frames.close();
		}
		const usage = sumUsage(walked.usage, 0);
		if (walked.failed !== undefined) return { ended: travelled(walked.failed), usage, failed: walked.failed };
		const last = walked.last?.ok ? { output: walked.last.output } : {};
		return { ended: { ok: true, output: { case: names[chosen], ...last } }, usage };
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
