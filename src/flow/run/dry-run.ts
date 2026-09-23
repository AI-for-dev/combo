/**
 * `dryRunFlow`: `runFlow` itself, with every agent turn answered by a script.
 *
 * The same walk, the same `spawn`, the same events. Only the session under
 * each subagent is scripted, so a typed answer goes through the real `submit`
 * tool, a verdict through the real `verdict` tool and its ledger, and a
 * failure takes its real path, retries and `fail-fast` included. Nothing of the
 * world is touched: no working directory is given, and no model is reached.
 */

import type { EventListener, VisitEvent } from "../../events.ts";
import { spawn } from "../../subagent.ts";
import type { Usage } from "../../usage.ts";
import type { SpawnFn } from "../../workflows/options.ts";
import type { CheckedFlow } from "../checked.ts";
import type { Attempt } from "./agent.ts";
import { Script, type AnswerFault, type Answers } from "./answers.ts";
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

/** Runs `checked` on `input`, each agent turn answered from `answers`. */
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
		if (turn === undefined) {
			unscripted ??= path;
			halt.abort();
		} else {
			sessions.get(subagent)?.stage(turn, controller);
		}
		return controller.signal;
	};

	const result = await walkFlow(checked, input, { ...options, signal, onEvent, spawn: scripted }, deadline);
	if (unscripted !== undefined) return { ok: false, unscripted, journal, usage: result.usage };
	return { ...result, journal };
}
