/**
 * `run()`: the disposable form. Spawn, ask, close.
 *
 * This is the only place where the lifetime is implicit - precisely because it
 * is entirely contained within the call. Nothing survives the return.
 */

import type { Agent } from "./agent.ts";
import type { Result } from "./result.ts";
import { spawn, type AskOptions, type SpawnOptions } from "./subagent.ts";

export type RunOptions = Omit<SpawnOptions, "lifetime"> & AskOptions;

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
	const { signal, timeoutMs, ...spawnOptions } = options;
	const subagent = await spawn(agent, { ...spawnOptions, lifetime: "task" });
	try {
		return await subagent.ask(task, { signal, timeoutMs });
	} finally {
		await subagent.close();
	}
}
