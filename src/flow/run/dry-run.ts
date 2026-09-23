/**
 * `dryRunFlow`: `runFlow` itself, with every agent turn, every check and
 * every commit answered by a script.
 *
 * The same walk, the same `spawn`, the same events. Only the session under
 * each subagent and the `check` port are scripted, so a typed answer goes
 * through the real `submit` tool, a verdict through the real `verdict` tool
 * and its ledger, and a failure takes its real path, retries and `fail-fast`
 * included. Nothing of the world is touched: it takes a `CheckedFlow`, no
 * working directory is given, no script is read, no model is reached and git
 * is never run. `diff` reads as an empty text, since no agent wrote anything,
 * and a `copies: true` block makes no copy: each of its branches reads as
 * landed.
 */

import type { EventListener, VisitEvent } from "../../events.ts";
import { spawn } from "../../subagent.ts";
import type { Usage } from "../../usage.ts";
import type { SpawnFn } from "../../workflows/options.ts";
import type { ScriptOutcome } from "../../verify.ts";
import type { CheckedCheckNode, CheckedCommitNode, CheckedFlow } from "../checked.ts";
import type { Attempt } from "./agent.ts";
import { Script, type AnswerFault, type Answers } from "./answers.ts";
import type { CommitOutcome } from "./commit.ts";
import { walkFlow, type FlowResult, type RunFlowOptions } from "./flow.ts";
import { scriptedSession, type ScriptedSession } from "./scripted.ts";

/** What a dry run varies: what a run does, short of reaching the world. */
export type DryRunOptions = Pick<RunFlowOptions, "signal" | "onEvent" | "model" | "timeoutMs">;

/** A `visit_end`, as the journal writes it down. */
export type JournalEntry = Extract<VisitEvent, { type: "visit_end" }>;

/**
 * How a dry run ended: as the flow did, or at the first visit its script did
 * not answer, which is no outcome of the flow's; or refused before the start,
 * with every fault of the script. The journal holds every visit that ended,
 * in order. Its tokens and cost are zero, since a script spends nothing;
 * the time is measured, like any run's.
 */
export type DryRun =
	| (FlowResult & { readonly journal: readonly JournalEntry[] })
	| { readonly ok: false; readonly unscripted: string; readonly journal: readonly JournalEntry[]; readonly usage: Usage }
	| { readonly ok: false; readonly faults: readonly AnswerFault[] };

/** Runs `checked` on `input`, each agent turn and each check answered from `answers`. */
export async function dryRunFlow(checked: CheckedFlow, input: unknown, answers: Answers, options: DryRunOptions = {}): Promise<DryRun> {
	const checkedScript = Script.check(checked, answers);
	if (!checkedScript.ok) return { ok: false, faults: checkedScript.faults };
	const { script } = checkedScript;

	const journal: JournalEntry[] = [];
	const onEvent: EventListener = (event) => {
		if (event.type === "visit_end") journal.push(event);
		options.onEvent?.(event);
	};
	// A hole in the script stops the run the way a person would, so nothing
	// in the flow can absorb it, and it is reported apart from the flow's end.
	const halt = new AbortController();
	const signal = options.signal === undefined ? halt.signal : AbortSignal.any([options.signal, halt.signal]);
	let unscripted: string | undefined;

	const sessions = new Map<string, ScriptedSession>();
	const scripted: SpawnFn = async (agent, spawnOptions) => {
		let session: ScriptedSession | undefined;
		const subagent = await spawn(agent, { ...spawnOptions, createSession: async (_agent, sessionOptions) => (session = scriptedSession(sessionOptions)) });
		sessions.set(subagent.id, session as ScriptedSession);
		return subagent;
	};
	// No clock: each attempt's deadline is a switch the scripted session
	// throws when its answer is a timeout.
	const deadline = ({ path, at, subagent }: Attempt) => {
		const controller = new AbortController();
		const turn = script.next(path, at);
		if (turn === undefined) hole(path);
		else sessions.get(subagent)?.stage(turn, controller);
		return controller.signal;
	};
	const ran = async <T extends ScriptOutcome | CommitOutcome>(node: CheckedCheckNode | CheckedCommitNode, path: string): Promise<T> => script.ran<T>(path, node.at) ?? hole<T>(path);
	const hole = <T extends ScriptOutcome | CommitOutcome>(path: string): T => {
		unscripted ??= path;
		halt.abort();
		return { ok: false, kind: "stopped", message: "unscripted" } as T;
	};
	const world = { deadline, check: ran<ScriptOutcome>, commit: ran<CommitOutcome>, diff: async () => ({ ok: true as const, value: "" }) };

	const result = await walkFlow(checked, input, { ...options, signal, onEvent, spawn: scripted }, world);
	if (unscripted !== undefined) return { ok: false, unscripted, journal, usage: result.usage };
	return { ...result, journal };
}
