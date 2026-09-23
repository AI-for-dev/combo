/**
 * One visit of a `check` node: the script the run stage read, run by the
 * `check` port in the tree the node stands in: the run's, or its branch's copy.
 *
 * A script that ran ends the node `ok: true`, red or green, since a red check
 * is a value the flow reads. Only a script that could not run or end fails it.
 */

import { emptyUsage } from "../../usage.ts";
import type { ScriptOutcome } from "../../verify.ts";
import type { CheckedCheckNode } from "../checked.ts";
import { failure, interruption, type Visited } from "./ended.ts";
import type { Here } from "./walk.ts";

/** What a check visit needs from the run around it. */
export type CheckingRun = {
	/** The run's signal: aborted, nothing starts and nothing catches the failure. */
	readonly signal: AbortSignal;
	/** Runs the script of `node` for the visit `path` in `tree`; aborting `signal` kills it. */
	check(node: CheckedCheckNode, path: string, signal: AbortSignal, tree: string | undefined): Promise<ScriptOutcome>;
};

/** Visits `node` at `path`. A stop or a cut is read off the signals, never off what the port says. */
export async function visitCheck(run: CheckingRun, node: CheckedCheckNode, path: string, here: Here): Promise<Visited> {
	const outcome = await run.check(node, path, AbortSignal.any([run.signal, here.cut]), here.tree);
	const cut = interruption(run.signal, here.cut);
	if (cut !== undefined) return { ended: { ok: false, error: cut }, usage: emptyUsage() };
	if (!outcome.ok) return { ended: failure(outcome.kind, outcome.message), usage: emptyUsage() };
	return { ended: { ok: true, output: { passed: outcome.passed, report: outcome.report } }, usage: emptyUsage() };
}
