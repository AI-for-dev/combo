/**
 * Walking a checked flow: a sequence node after node, each visit announced on
 * the event stream, and a failure travelling up until a node absorbs it.
 *
 * Our code decides what runs next. A model's output is a value a `choice`
 * reads; it never names a node. The blocks that open branches are in
 * `blocks.ts` and `choice.ts`, the loop in `loop.ts`, a call in `call.ts`,
 * and each comes back through {@link Run.sequence}. What the walk is given
 * is in `world.ts`.
 */

import type { Agent } from "../../agent.ts";
import { declaresDelegate, delegateTool } from "../../delegate.ts";
import type { GitResult } from "../../git/index.ts";
import { VERDICT_TOOL } from "../../review/index.ts";
import { toolsOf, type ToolDefinition } from "../../session.ts";
import type { SpawnOptions } from "../../subagent.ts";
import { emptyUsage, sumUsage, type Usage } from "../../usage.ts";
import type { ScriptOutcome } from "../../verify.ts";
import { turnTimeout } from "../bounds.ts";
import type { CheckedAgentNode, CheckedAskNode, CheckedCallNode, CheckedCheckNode, CheckedCommitNode, CheckedFlow, CheckedNode, FlowError } from "../checked.ts";
import { sharedKey, sharedSubagents, submitted } from "../memory.ts";
import { visitAgent, type AgentRun, type Attempt } from "./agent.ts";
import { visitAsk, type AskingRun, type Card, type Heard } from "./ask.ts";
import { visitMap, visitParallel } from "./blocks.ts";
import { visitCall, type CallingRun } from "./call.ts";
import { visitCheck, type CheckingRun } from "./check.ts";
import { visitChoice } from "./choice.ts";
import { visitCommit, type CommitOutcome, type CommittingRun } from "./commit.ts";
import type { Copies } from "./copies.ts";
import { interruption, under, type Ended, type Visited, type Walked } from "./ended.ts";
import type { Frames, Held } from "./frames.ts";
import type { Journal, VisitEnd } from "./journal.ts";
import { visitLoop } from "./loop.ts";
import { SUBMIT_TOOL, submitTool } from "./submit.ts";
import type { Replay } from "./replay.ts";
import type { Values } from "./values.ts";
import { verdictSlot } from "./verdict.ts";
import type { Walk } from "./world.ts";

/**
 * Where a visit stands: what it reads, the memory scopes open around it, the
 * signal that cuts it short, the run's own or a `fail-fast` block's, and the
 * working tree it acts in: the run's, or its branch's copy inside a
 * `copies: true` block. A dry run has none.
 */
export type Here = { readonly values: Values; readonly frames: Frames; readonly cut: AbortSignal; readonly tree: string | undefined };

/** What a block needs of the walk: the run's signal, the copies it makes, the journal, what a resume kept of it, and a sequence walked inside it. */
export type Walker = {
	readonly signal: AbortSignal;
	readonly copies?: Copies;
	readonly journal: Journal;
	readonly replay?: Replay;
	sequence(nodes: readonly CheckedNode[], prefix: string, here: Here): Promise<Walked>;
};

/**
 * One run of a checked flow, or of a flow it calls: a callee's is the run's
 * own, one call further down. The world and the settings are the run's,
 * whatever file a node is in, so one queue of cards and one run branch serve
 * every call. What a file writes, `model:` and `timeout:`, is read from the
 * callee outward, and the world is told each node by its address through the
 * calls, `spec/ask_next`.
 */
export class Run implements AgentRun, AskingRun, CallingRun, CheckingRun, CommittingRun, Walker {
	readonly signal: AbortSignal;
	readonly copies?: Copies;
	readonly journal: Journal;
	readonly replay?: Replay;
	private readonly walk: Walk;
	/** The flow walked, then each one that called it, outward. */
	private readonly stack: readonly CheckedFlow[];
	/** The address of the call this flow is walked for, through the calls above it; `""` at the root. */
	private readonly prefix: string;
	private readonly shared: ReturnType<typeof sharedSubagents>;

	constructor(walk: Walk, stack: readonly CheckedFlow[] = [walk.flow], prefix = "") {
		this.walk = walk;
		this.signal = walk.signal;
		this.copies = walk.copies;
		this.journal = walk.journal;
		this.replay = walk.replay;
		this.stack = stack;
		this.prefix = prefix;
		this.shared = sharedSubagents((stack[0] as CheckedFlow).nodes);
	}

	called(node: CheckedCallNode): Run {
		return new Run(this.walk, [node.callee, ...this.stack], this.address(node.at));
	}

	whole(node: CheckedCallNode, path: string): Ended | undefined {
		return this.walk.whole?.(this.addressed(node), path);
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
		return this.walk.timeoutMs ?? turnTimeout(node, this.stack.find((flow) => flow.timeoutMs !== undefined)?.timeoutMs).ms;
	}

	deadline(attempt: Attempt): AbortSignal {
		return this.walk.deadline({ ...attempt, at: this.address(attempt.at) });
	}

	check(node: CheckedCheckNode, path: string, signal: AbortSignal, tree: string | undefined): Promise<ScriptOutcome> {
		return this.walk.check(this.addressed(node), path, signal, tree);
	}

	commit(node: CheckedCommitNode, path: string, message: string): Promise<CommitOutcome> {
		return this.walk.commit(this.addressed(node), path, message);
	}

	diff(tree: string | undefined): Promise<GitResult<string>> {
		return this.walk.diff(tree);
	}

	ask(node: CheckedAskNode, path: string, card: Card, cut: AbortSignal): Promise<Heard> {
		return this.walk.ask(this.addressed(node), path, card, cut);
	}

	stop(): void {
		this.walk.stop();
	}

	/**
	 * A subagent with the tools every node it serves answers with: one node
	 * without `memory:`, every node sharing it with one. The flow asked for a
	 * typed value or a verdict, so the agent is given the tool that hands it
	 * back; `tools:` is an allowlist, and it covers ours too. An agent whose
	 * `tools:` names `subagent` is handed one. Its transcript goes in `home`.
	 */
	async open(agent: Agent, node: CheckedAgentNode, path: string, tree: string | undefined, home: string): Promise<Held> {
		const serves = node.memory === undefined ? [node] : (this.shared.get(sharedKey(node.memory, agent.name)) ?? []);
		const type = submitted(serves);
		const submit = type === undefined ? undefined : submitTool(type);
		const decides = serves.some((one) => one.verdict !== undefined);
		const added = [...(submit === undefined ? [] : [SUBMIT_TOOL]), ...(decides ? [VERDICT_TOOL] : [])];
		const holder = { ...agent, tools: added.length === 0 ? agent.tools : [...toolsOf(agent), ...added] };
		const verdict = decides ? verdictSlot(holder) : undefined;
		const { spawn, transcripts, bus } = this.walk;
		// The run's, then the flows', callee outward; `spawn` falls back on the agent's own.
		const model = this.walk.model ?? this.stack.find((flow) => flow.model !== undefined)?.model;
		const delegate = declaresDelegate(agent.tools) ? this.delegate(holder, node, tree, model) : undefined;
		const options: SpawnOptions = {
			lifetime: node.memory === undefined ? "task" : "workflow",
			bus,
			cwd: tree,
			model,
			customTools: (id) => [submit?.tool, verdict?.tool, delegate?.(id)].filter((tool) => tool !== undefined),
			visit: path,
		};
		const subagent = await (transcripts?.atHome(spawn, holder, options, home) ?? spawn(holder, options));
		return { subagent, submit, verdict };
	}

	/**
	 * The `subagent` tool of `holder`, handed to it once its id is known: its
	 * children are drawn from the agents the flow names, which the snapshot
	 * keeps, and their transcripts go beside `holder`'s.
	 */
	private delegate(holder: Agent, node: CheckedAgentNode, tree: string | undefined, model: string | undefined): (parentId: string) => ToolDefinition {
		const { spawn, transcripts, bus, signal } = this.walk;
		const agents = this.walk.flow.sources.agents.map((named) => named.agent);
		const children = transcripts?.children(spawn) ?? spawn;
		return (parentId) => delegateTool({ agents, holder, parentId, spawn: children, bus, cwd: tree, model, signal, timeoutMs: this.timeoutFor(node) });
	}

	/**
	 * One visit, between its `visit_start` and its `visit_end`, which is
	 * written down before it is told; or, on a resume, how it ended before,
	 * neither told nor written again.
	 */
	private async visit(node: CheckedNode, path: string, here: Here): Promise<Visited> {
		const kept = this.replay?.ended(path);
		if (kept !== undefined) return { ended: kept, usage: emptyUsage(), ...(!kept.ok && { failed: { path, error: kept.error } }) };
		const { bus } = this.walk;
		bus.emit({ type: "visit_start", path, node: this.address(node.at), kind: node.kind });
		const started = performance.now();
		const visit = await this.dispatch(node, path, here);
		const wallMs = performance.now() - started;
		const usage = { ...visit.usage, wallMs };
		const { ended, agent, subagent, model } = visit;
		const end: VisitEnd = {
			type: "visit_end",
			path,
			node: this.address(node.at),
			kind: node.kind,
			ok: ended.ok,
			...told(node, ended),
			...(agent !== undefined && { agent }),
			...(subagent !== undefined && { subagent }),
			...(model !== undefined && { model }),
			wallMs,
			usage,
		};
		this.journal.append(end);
		bus.emit(end);
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
			case "flow":
				return visitCall(this, node, path, here);
		}
	}

	/** The address of `at`, an address in this flow's file, through the calls that reached it. */
	private address(at: string): string {
		return this.prefix === "" ? at : `${this.prefix}/${at}`;
	}

	/** `node` as the world is told it: at its address through the calls. */
	private addressed<T extends CheckedNode>(node: T): T {
		return this.prefix === "" ? node : { ...node, at: this.address(node.at) };
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
