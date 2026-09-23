/**
 * Memory scopes at run time: the subagents each open scope holds.
 *
 * A scope opens with a visit of the node it is named after (the run itself
 * for `flow`) and holds one subagent per agent, spawned the first time a node
 * inside it asks and resumed by every later one. Whoever opens, closes: the
 * visit that opened a scope closes its subagents when it ends, in a `finally`.
 */

import type { Subagent } from "../../subagent.ts";
import type { SubmitTool } from "./submit.ts";

/** A subagent a visit asks, and what it answers a typed node with. */
export type Held = {
	/** Closed by whoever opened it: the visit, or the scope that keeps it. */
	readonly subagent: Subagent;
	/** The `submit` tool it was spawned with, when a node it serves is typed. */
	readonly submit?: SubmitTool;
};

type Frame = { readonly id: string; readonly held: Map<string, Promise<Held>> };

/** The memory scopes open where a visit stands, outermost first. */
export class Frames {
	private readonly frames: readonly Frame[];

	private constructor(frames: readonly Frame[]) {
		this.frames = frames;
	}

	/** The run's own scope, `flow`. */
	static root(): Frames {
		return new Frames([{ id: "flow", held: new Map() }]);
	}

	/** The scopes inside a visit of the structural node `id`, which opens one of its own. */
	inside(id: string): Frames {
		return new Frames([...this.frames, { id, held: new Map() }]);
	}

	/**
	 * The subagent of `agent` in the scope named `scope`, opened by `open` the
	 * first time. The promise is kept, not its result, so two nodes asking at
	 * once cannot spawn two.
	 */
	held(scope: string, agent: string, open: () => Promise<Held>): Promise<Held> {
		const frame = this.frames.findLast((one) => one.id === scope);
		if (frame === undefined) throw new Error(`No memory scope \`${scope}\` is open here`);
		const existing = frame.held.get(agent);
		if (existing !== undefined) return existing;
		const opened = open();
		frame.held.set(agent, opened);
		return opened;
	}

	/** Closes the subagents of the innermost scope, the one this visit opened. */
	async close(): Promise<void> {
		const frame = this.frames.at(-1);
		const held = [...(frame?.held.values() ?? [])];
		frame?.held.clear();
		await Promise.allSettled(held.map(async (one) => (await one).subagent.close()));
	}
}
