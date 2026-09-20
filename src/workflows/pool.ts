/**
 * The pool: where a workflow's turns are played.
 *
 * A combinator says who speaks and what it is asked. The pool does the rest -
 * who is spawned, who is reused, who is closed, and with which signal and
 * deadline every turn runs. That is written here once, so that a combinator
 * cannot forget half of it.
 */

import type { Agent, Lifetime } from "./../agent.ts";
import { busFor } from "./../events.ts";
import { failed, type Result } from "./../result.ts";
import { spawn as defaultSpawn, type AskOptions, type SpawnOptions, type Subagent } from "./../subagent.ts";
import type { SpawnFn, WorkflowOptions } from "./options.ts";

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
	private readonly live = new Map<string, Subagent>();
	private readonly owned: Subagent[] = [];
	private readonly lifetime: Lifetime;
	private readonly spawnFn: SpawnFn;
	private readonly spawnOptions: SpawnOptions;
	private readonly askOptions: AskOptions;
	private readonly customTools: WorkflowOptions["customTools"];

	constructor(options: WorkflowOptions) {
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
	 * A signal already aborted is answered without spawning anything. Whatever
	 * happens during the turn, the subagent is given back - which in `"task"`
	 * lifetime means closed.
	 */
	async turn(agent: Agent, task: string, options: TurnOptions = {}): Promise<Result> {
		if (this.askOptions.signal?.aborted) return failed(agent.name, "aborted");

		const subagent = await this.acquire(agent, options.key ?? agent.name);
		try {
			return await subagent.ask(task, this.askOptions);
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
	 */
	async hold(agent: Agent, options: TurnOptions = {}): Promise<Held> {
		const subagent = await this.acquire(agent, options.key ?? agent.name);
		return { id: subagent.id, ask: (task) => subagent.ask(task, this.askOptions) };
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
