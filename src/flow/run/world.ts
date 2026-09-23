/**
 * What a walk is given: the flow and the run's settings, and how it reaches
 * the world. A real run's world comes from its `CheckedRun`; a dry run's is
 * scripted. Either is one for the whole run, whatever flow a node is in.
 */

import type { EventBus } from "../../events.ts";
import type { GitResult } from "../../git/index.ts";
import type { ScriptOutcome } from "../../verify.ts";
import type { SpawnFn } from "../../workflows/options.ts";
import type { CheckedAskNode, CheckedCallNode, CheckedCheckNode, CheckedCommitNode, CheckedFlow } from "../checked.ts";
import type { Attempt } from "./agent.ts";
import type { Card, Heard } from "./ask.ts";
import type { CommitOutcome } from "./commit.ts";
import type { Copies } from "./copies.ts";
import type { Ended } from "./ended.ts";
import type { Journal } from "./journal.ts";
import type { Replay } from "./replay.ts";

/**
 * How a walk reaches the world: the deadline of each agent attempt, a
 * check's script run in a tree, a commit, the `diff` of a tree, the copies of
 * a block, a question put to the person, the journal each fact is written
 * to, and on a resume what the journal already held. A real run's come from
 * its `CheckedRun` and its run directory; a dry run's are scripted, and it
 * makes no copy.
 */
export type World = {
	deadline(attempt: Attempt): AbortSignal;
	check(node: CheckedCheckNode, path: string, signal: AbortSignal, tree: string | undefined): Promise<ScriptOutcome>;
	commit(node: CheckedCommitNode, path: string, message: string): Promise<CommitOutcome>;
	diff(tree: string | undefined): Promise<GitResult<string>>;
	ask(node: CheckedAskNode, path: string, card: Card, cut: AbortSignal): Promise<Heard>;
	/** A call answered whole, without walking into its callee: a dry run's, when its script says so. */
	whole?(node: CheckedCallNode, path: string): Ended | undefined;
	readonly copies?: Copies;
	readonly journal: Journal;
	/** What a resume kept of the journal: a visit it holds that survives is not visited again. */
	readonly replay?: Replay;
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
