/**
 * `run()`: the disposable form. Spawn, ask, close.
 *
 * This is the only place where the lifetime is implicit - precisely because it
 * is entirely contained within the call. Nothing survives the return.
 */

import type { Agent } from "./agent.ts";
import type { Result } from "./result.ts";
import { spawn as defaultSpawn, type AskOptions, type SpawnOptions } from "./subagent.ts";
import type { SpawnFn } from "./workflows/common.ts";

/** {@link SpawnOptions} without `lifetime` - `run` is `"task"` by definition - plus the per-turn deadline. */
export type RunOptions = Omit<SpawnOptions, "lifetime"> &
	AskOptions & {
		/** Defaults to the real {@link spawn}, like every combinator's. */
		spawn?: SpawnFn;
	};

/**
 * Runs one task with a throwaway subagent.
 *
 * The lifetime is forced to `"task"`: an agent whose frontmatter declares
 * `lifetime: workflow` gains nothing from persisting across a single turn.
 * Use {@link spawn} when the memory must outlive the call.
 *
 * The session is closed even if the turn fails or is cancelled.
 */
export async function run(agent: Agent, task: string, options: RunOptions = {}): Promise<Result> {
	const { signal, timeoutMs, spawn = defaultSpawn, ...spawnOptions } = options;
	const subagent = await spawn(agent, { ...spawnOptions, lifetime: "task" });
	try {
		return await subagent.ask(task, { signal, timeoutMs });
	} finally {
		await subagent.close();
	}
}
