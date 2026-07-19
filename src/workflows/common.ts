/**
 * What every combinator shares: the same options, the same defaults, and the
 * same way of honouring lifetime.
 *
 * Combinators are functions, not classes. No inheritance, no global registry.
 * They compose because they all take a `Result` in and give a `Result` back.
 */

import type { Agent, Lifetime } from "./../agent.ts";
import { createEventBus, type EventBus, type EventListener } from "./../events.ts";
import { spawn as defaultSpawn, type SpawnOptions, type Subagent } from "./../subagent.ts";

/** The spawn function a combinator uses. Injection point for tests. */
export type SpawnFn = (agent: Agent, options: SpawnOptions) => Promise<Subagent>;

/** Options common to every workflow - same names, same defaults, everywhere. */
export type WorkflowOptions = {
	/** Defaults to `"task"`. Persistence is asked for, never assumed. */
	lifetime?: Lifetime;
	/** Propagated down to every `session.prompt()`, and closes open sessions. */
	signal?: AbortSignal;
	/**
	 * Deadline **per turn**, not for the whole workflow. No default.
	 *
	 * A chain of five steps with `timeoutMs: 60_000` can legitimately run for
	 * five minutes; what it cannot do is hang forever on one of them. See
	 * {@link AskOptions.timeoutMs} for why that guard is needed at all.
	 */
	timeoutMs?: number;
	onEvent?: EventListener;
	bus?: EventBus;
	cwd?: string;
	sessionDir?: string;
	/** Give every subagent of this workflow its own herdr split. Opt-in. */
	openInHerdr?: boolean;
	/** Defaults to the real {@link spawn}. */
	spawn?: SpawnFn;
};

/**
 * Holds the subagents a workflow created, and closes them all.
 *
 * The lifetime rule lives here, in one place:
 * - `"task"`: a fresh subagent per acquisition, closed as soon as it is released.
 * - anything else: one subagent per key, reused, closed at the end.
 *
 * The `key` is what decides who shares a memory. A chain keys by agent name -
 * the same reviewer across iterations. A fan-out keys by branch - two
 * branches must never share a context.
 */
export class SubagentPool {
	private readonly live = new Map<string, Subagent>();
	private readonly owned: Subagent[] = [];
	private readonly lifetime: Lifetime;
	private readonly spawnFn: SpawnFn;
	private readonly spawnOptions: SpawnOptions;

	constructor(options: WorkflowOptions) {
		this.lifetime = options.lifetime ?? "task";
		this.spawnFn = options.spawn ?? defaultSpawn;

		const bus = options.bus ?? createEventBus();
		if (options.onEvent) bus.subscribe(options.onEvent);
		this.spawnOptions = {
			lifetime: this.lifetime,
			bus,
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			openInHerdr: options.openInHerdr,
		};
	}

	/** Gets a subagent for this key, creating it if the lifetime calls for it. */
	async acquire(agent: Agent, key: string): Promise<Subagent> {
		const existing = this.lifetime === "task" ? undefined : this.live.get(key);
		if (existing) return existing;

		const subagent = await this.spawnFn(agent, this.spawnOptions);
		this.owned.push(subagent);
		if (this.lifetime !== "task") this.live.set(key, subagent);
		return subagent;
	}

	/** Gives a subagent back. In `"task"` lifetime this closes it right away. */
	async release(subagent: Subagent): Promise<void> {
		if (this.lifetime !== "task") return;
		await subagent.close();
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
}

/** Turns an abort into the same failure shape every combinator returns. */
export function abortError(signal: AbortSignal | undefined): string | undefined {
	return signal?.aborted ? "aborted" : undefined;
}
