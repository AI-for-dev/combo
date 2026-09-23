/**
 * Walking a checked flow: a sequence node after node, each visit announced on
 * the event stream, and a failure travelling up until a node absorbs it.
 *
 * Our code decides what runs next. A model's output is a value a `choice`
 * reads; it never names a node.
 */

import type { Agent } from "../../agent.ts";
import type { EventBus } from "../../events.ts";
import { emptyUsage, sumUsage, type Usage } from "../../usage.ts";
import type { SpawnFn } from "../../workflows/options.ts";
import { toolsOf } from "../../session.ts";
import { caseNames, type CheckedAgentNode, type CheckedChoiceNode, type CheckedFlow, type CheckedNode } from "../checked.ts";
import { evaluateCondition } from "../condition/index.ts";
import { sharedKey, sharedSubagents, submitted } from "../memory.ts";
import { visitAgent, type AgentRun, type Attempt } from "./agent.ts";
import { failure, travelled, under, type Ended, type Failed } from "./ended.ts";
import type { Frames, Held } from "./frames.ts";
import { SUBMIT_TOOL, submitTool } from "./submit.ts";
import type { Values } from "./values.ts";

/** An agent turn's bound when neither the node, nor the flow, nor the caller sets one. */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** How a sequence ended: its last node as it ended, what it cost, and the failure that stopped it. */
export type Walked = { readonly last?: Ended; readonly usage: readonly Usage[]; readonly failed?: Failed };

/** How a visit ended, what it cost, the failure it started from, and for an `agent` visit who ran it. */
type Visited = { readonly ended: Ended; readonly usage: Usage; readonly failed?: Failed; readonly agent?: string; readonly model?: string };

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
export class Run implements AgentRun {
	readonly signal: AbortSignal;
	private readonly walk: Walk;
	private readonly shared: ReturnType<typeof sharedSubagents>;

	constructor(walk: Walk) {
		this.walk = walk;
		this.signal = walk.signal;
		this.shared = sharedSubagents(walk.flow.nodes);
	}

	/** `nodes` in order, inside the visit `prefix`. A failure not absorbed ends the sequence there. */
	async sequence(nodes: readonly CheckedNode[], prefix: string, values: Values, frames: Frames): Promise<Walked> {
		const usage: Usage[] = [];
		let last: Ended | undefined;
		for (const node of nodes) {
			const path = under(prefix, node.id);
			if (this.signal.aborted) return { last, usage, failed: { path, error: { kind: "stopped", message: "the run was stopped" } } };
			const visit = await this.visit(node, path, values, frames);
			values.end(node.id, visit.ended);
			usage.push(visit.usage);
			last = visit.ended;
			// A stopped run is caught by nothing, `on-fail: continue` included.
			if (!visit.ended.ok && (!node.continueOnFail || this.signal.aborted)) return { last, usage, failed: visit.failed };
		}
		return { last, usage };
	}

	timeoutFor(node: CheckedAgentNode): number {
		return this.walk.timeoutMs ?? node.timeoutMs ?? this.walk.flow.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	deadline(attempt: Attempt): AbortSignal {
		return this.walk.deadline(attempt);
	}

	async open(agent: Agent, node: CheckedAgentNode): Promise<Held> {
		const type = node.memory === undefined ? node.output : submitted(this.shared.get(sharedKey(node.memory, agent.name)) ?? []);
		const submit = type === undefined ? undefined : submitTool(type);
		// The flow asked for a typed value, so the agent is given the one tool
		// that hands it back; `tools:` is an allowlist, and it covers ours too.
		const tools = submit === undefined ? agent.tools : [...toolsOf(agent), SUBMIT_TOOL];
		const subagent = await this.walk.spawn(
			{ ...agent, tools },
			{
				lifetime: node.memory === undefined ? "task" : "workflow",
				bus: this.walk.bus,
				cwd: this.walk.cwd,
				// The run's, then the flow's; `spawn` falls back on the agent's own.
				model: this.walk.model ?? this.walk.flow.model,
				customTools: submit && [submit.tool],
			},
		);
		return { subagent, submit };
	}

	/** One visit, between its `visit_start` and its `visit_end`. */
	private async visit(node: CheckedNode, path: string, values: Values, frames: Frames): Promise<Visited> {
		const { bus } = this.walk;
		bus.emit({ type: "visit_start", path, node: node.at, kind: node.kind });
		const started = performance.now();
		const visit = await this.dispatch(node, path, values, frames);
		const wallMs = performance.now() - started;
		const usage = { ...visit.usage, wallMs };
		const { ended, agent, model } = visit;
		const told = ended.ok ? { output: ended.output, ...(node.kind === "choice" && { case: (ended.output as { case: string }).case }) } : { error: ended.error };
		bus.emit({ type: "visit_end", path, ok: ended.ok, ...told, ...(agent !== undefined && { agent }), ...(model !== undefined && { model }), wallMs, usage });
		return { ended, usage, failed: visit.failed ?? (ended.ok ? undefined : { path, error: ended.error }) };
	}

	private async dispatch(node: CheckedNode, path: string, values: Values, frames: Frames): Promise<Visited> {
		switch (node.kind) {
			case "agent":
				return visitAgent(this, node, path, values, frames);
			case "choice":
				return this.choice(node, path, values, frames);
			default:
				throw notYet(node);
		}
	}

	/** The first case whose condition holds, else the default, in a scope of its own. */
	private async choice(node: CheckedChoiceNode, path: string, values: Values, frames: Frames): Promise<Visited> {
		const names = caseNames(node.cases.length);
		let chosen = node.cases.length;
		for (const [index, one] of node.cases.entries()) {
			const holds = evaluateCondition(one.when, values.all());
			if (!holds.ok) return { ended: failure("condition", `\`${one.when.source.trim()}\`: ${holds.message}`), usage: emptyUsage() };
			if (holds.value) {
				chosen = index;
				break;
			}
		}
		const inner = frames.inside(node.id);
		let walked: Walked;
		try {
			walked = await this.sequence(node.cases[chosen]?.nodes ?? node.otherwise, path, values.inside(), inner);
		} finally {
			await inner.close();
		}
		const usage = sumUsage(walked.usage, 0);
		if (walked.failed !== undefined) return { ended: travelled(walked.failed), usage, failed: walked.failed };
		const last = walked.last?.ok ? { output: walked.last.output } : {};
		return { ended: { ok: true, output: { case: names[chosen], ...last } }, usage };
	}
}

/**
 * The refusal of a node this runner does not walk yet: a programming error,
 * since the flow was checked and the runner is what falls short.
 */
export function notYet(node: CheckedNode): Error {
	const what = node.kind === "agent" ? "`verdict:` on an `agent` node" : `a \`${node.kind}\` node`;
	return new Error(`\`${node.at}\`: ${what} is not run yet by the flow runner`);
}
