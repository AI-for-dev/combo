/**
 * Memory scopes at run time: the subagents each open scope holds, and the
 * ledger it keeps.
 *
 * A scope opens with a visit of the node it is named after (the run itself
 * for `flow`), or with each item of a `map` and each branch of a `parallel`,
 * and holds one subagent per agent, spawned the first time a node inside it
 * asks and resumed by every later one. Whoever opens, closes: what opened a
 * scope closes its subagents when it ends, in a `finally`.
 */

import type { Ledger } from "../../review/index.ts";
import type { KeptLedger } from "./journal.ts";
import type { Subagent } from "../../subagent.ts";
import type { SubmitTool } from "./submit.ts";
import type { VerdictSlot } from "./verdict.ts";

/** A subagent a visit asks, and the tools it answers a typed or a verdict node with. */
export type Held = {
	/** Closed by whoever opened it: the visit, or the scope that keeps it. */
	readonly subagent: Subagent;
	/** The `submit` tool it was spawned with, when a node it serves is typed. */
	readonly submit?: SubmitTool;
	/** The `verdict` tool it was spawned with, when a node it serves has `verdict:`. */
	readonly verdict?: VerdictSlot;
};

/** A subagent a scope keeps, and the turn of the last visit that asked it, which the next one waits for. */
type Kept = { readonly held: Promise<Held>; queue: Promise<unknown> };

type Frame = { readonly id: string; readonly kept: Map<string, Kept>; readonly ledger?: KeptLedger };

/** The memory scopes open where a visit stands, outermost first. */
export class Frames {
	private readonly frames: readonly Frame[];

	private constructor(frames: readonly Frame[]) {
		this.frames = frames;
	}

	/** The run's own scope, `flow`. */
	static root(): Frames {
		return new Frames([{ id: "flow", kept: new Map() }]);
	}

	/** The scopes inside the structural node `id`, which opens one of its own, keeping `ledger` when it has one. */
	inside(id: string, ledger?: KeptLedger): Frames {
		return new Frames([...this.frames, { id, kept: new Map(), ledger }]);
	}

	/**
	 * Runs `use` on the subagent of `agent` in the scope named `scope`, opened
	 * by `open` the first time. One visit at a time: a subagent takes one turn
	 * at once, and branches running together may share an outer scope's.
	 */
	use<T>(scope: string, agent: string, open: () => Promise<Held>, use: (held: Held) => Promise<T>): Promise<T> {
		const { kept } = this.frame(scope);
		let one = kept.get(agent);
		if (one === undefined) {
			// The promise is kept, not its result, so two visits asking at once cannot spawn two.
			one = { held: open(), queue: Promise.resolve() };
			kept.set(agent, one);
		}
		const { held } = one;
		const turn = one.queue.then(async () => use(await held));
		one.queue = turn.catch(() => undefined);
		return turn;
	}

	/** The ledger of the scope named `scope`, the nearest one. */
	ledger(scope: string): KeptLedger {
		const { ledger } = this.frame(scope);
		if (ledger === undefined) throw new Error(`The memory scope \`${scope}\` keeps no ledger`);
		return ledger;
	}

	/** Closes the subagents of the innermost scope, the one this visit opened. */
	async close(): Promise<void> {
		const frame = this.frames.at(-1);
		const kept = [...(frame?.kept.values() ?? [])];
		frame?.kept.clear();
		await Promise.allSettled(kept.map(async (one) => (await one.held).subagent.close()));
	}

	private frame(scope: string): Frame {
		const frame = this.frames.findLast((one) => one.id === scope);
		if (frame === undefined) throw new Error(`No memory scope \`${scope}\` is open here`);
		return frame;
	}
}

/**
 * `own`, a block's own id as its body reads it, with `ledger` added the way
 * `<scope>.ledger` reads it: the open obligations at the moment the address
 * is read, since a verdict in the same iteration changes them.
 */
export function withLedger<T extends object>(own: T, ledger: Ledger | undefined): T {
	if (ledger !== undefined) Object.defineProperty(own, "ledger", { enumerable: true, get: () => ledger.open.map(({ id, text }) => ({ id, text })) });
	return own;
}
