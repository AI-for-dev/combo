/**
 * The pool: where a workflow's turns are played.
 *
 * A combinator says who speaks and what it is asked. The pool does the rest -
 * who is spawned, who is reused, who is closed, with which signal and deadline
 * every turn runs, and what the turns add up to. That is written here once, so
 * that a combinator cannot forget half of it.
 */

import type { Agent, Lifetime } from "./../agent.ts";
import { busFor } from "./../events.ts";
import { failed, type Result } from "./../result.ts";
import { spawn as defaultSpawn, type AskOptions, type SpawnOptions, type Subagent } from "./../subagent.ts";
import type { SpawnFn, WorkflowOptions } from "./options.ts";
import { Trail } from "./trail.ts";

/** Which subagent a turn goes to. */
export type TurnOptions = {
	/**
	 * Who shares a memory. Defaults to the agent's name.
	 *
	 * In a persistent lifetime, two turns under one key reach the same
	 * subagent: a chain keys by name so the same reviewer comes back with its
	 * remarks in mind. A fan-out keys by branch, because two branches must never
	 * share a context.
	 */
	key?: string;
};

/**
 * A subagent held for a conversation.
 *
 * What a caller gets from {@link SubagentPool.hold}: enough to address it and
 * to ask it several things in a row, with the workflow's signal and deadline
 * on every turn. Not the `Subagent` itself - closing it stays the pool's job.
 *
 * A hold refused on a signal already aborted is addressed by its key, and
 * every `ask` answers the same refusal without spawning anything.
 */
export type Held = {
	/** The subagent's id, which is its name wherever it is addressed. */
	readonly id: string;
	/** One turn, with the workflow's `signal` and `timeoutMs`. */
	ask(task: string): Promise<Result>;
};

/**
 * Holds the subagents a workflow created, plays their turns, and closes them
 * all.
 *
 * The lifetime rule lives here, in one place:
 * - `"task"`: a fresh subagent per turn, closed as soon as the turn is over.
 * - anything else: one subagent per key, reused, closed at the end.
 *
 * A held subagent is the exception: a conversation is not a task, so it lives
 * until {@link closeAll} whatever the lifetime.
 */
export class SubagentPool {
	/**
	 * Every turn this pool played, refusals included, and what they add up to.
	 *
	 * A combinator that keeps its own list, its own clock and its own sum next
	 * to this one has three chances to drift from it; reading these is how it
	 * reports what it did.
	 */
	readonly trail: Trail;
	private readonly live = new Map<string, Subagent>();
	private readonly owned: Subagent[] = [];
	private readonly lifetime: Lifetime;
	private readonly spawnFn: SpawnFn;
	private readonly spawnOptions: SpawnOptions;
	private readonly askOptions: AskOptions;
	private readonly customTools: WorkflowOptions["customTools"];

	/**
	 * `trail` is the caller's when its clock has to start before the pool can
	 * exist, or when it records steps of its own beside the pool's.
	 */
	constructor(options: WorkflowOptions, trail = new Trail()) {
		this.trail = trail;
		this.lifetime = options.lifetime ?? "task";
		this.spawnFn = options.spawn ?? defaultSpawn;
		this.customTools = options.customTools;
		this.askOptions = { signal: options.signal, timeoutMs: options.timeoutMs };

		const bus = busFor(options);
		this.spawnOptions = {
			lifetime: this.lifetime,
			bus,
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			exportDir: options.exportDir,
			openInHerdr: options.openInHerdr,
			model: options.model,
			parentId: options.parentId,
		};
	}

	/**
	 * Plays one turn: the agent is asked `task`, and what it said comes back.
	 *
	 * A signal already aborted is answered without spawning anything, and the
	 * refusal is a step on the trail like any other turn: a chain that was
	 * called off says so where the answer would have been. Whatever happens
	 * during the turn, the subagent is given back - which in `"task"` lifetime
	 * means closed.
	 */
	async turn(agent: Agent, task: string, options: TurnOptions = {}): Promise<Result> {
		if (this.askOptions.signal?.aborted) return this.refuse(agent);

		const subagent = await this.acquire(agent, options.key ?? agent.name);
		try {
			return await this.play(subagent, task);
		} finally {
			await this.release(subagent);
		}
	}

	/**
	 * Holds a subagent for a conversation of several turns.
	 *
	 * Where {@link turn} gives a subagent back after one answer, this keeps it
	 * until {@link closeAll}: an interviewer that forgot the previous question,
	 * or a swarm member with a new name every round, would not be a conversation.
	 *
	 * A signal already aborted is refused here, before the spawn, the way a turn
	 * is: a held subagent is spawned before it is asked anything, so a check on
	 * its first `ask` would come after the session it was meant to spare.
	 */
	async hold(agent: Agent, options: TurnOptions = {}): Promise<Held> {
		const key = options.key ?? agent.name;
		if (this.askOptions.signal?.aborted) return { id: key, ask: async () => this.refuse(agent) };

		const subagent = await this.acquire(agent, key);
		return { id: subagent.id, ask: (task) => this.play(subagent, task) };
	}

	/**
	 * Closes everything this pool opened. Whoever opens, closes - including on
	 * cancellation, which is why callers put this in a `finally`.
	 */
	async closeAll(): Promise<void> {
		const toClose = this.owned.splice(0);
		this.live.clear();
		await Promise.allSettled(toClose.map((subagent) => subagent.close()));
	}

	/** One turn, with the workflow's options, recorded on the trail. */
	private async play(subagent: Subagent, task: string): Promise<Result> {
		return this.trail.record(await subagent.ask(task, this.askOptions));
	}

	/** The answer to a turn nobody will play: a failure that says so, on the trail. */
	private refuse(agent: Agent): Result {
		return this.trail.record(failed(agent.name, "aborted"));
	}

	/** Gets a subagent for this key, creating it if the lifetime calls for it. */
	private async acquire(agent: Agent, key: string): Promise<Subagent> {
		const existing = this.lifetime === "task" ? undefined : this.live.get(key);
		if (existing) return existing;

		const subagent = await this.spawnFn(agent, { ...this.spawnOptions, customTools: this.customTools?.(agent) });
		this.owned.push(subagent);
		if (this.lifetime !== "task") this.live.set(key, subagent);
		return subagent;
	}

	/** Gives a subagent back. In `"task"` lifetime this closes it right away. */
	private async release(subagent: Subagent): Promise<void> {
		if (this.lifetime !== "task") return;
		await subagent.close();
	}
}
