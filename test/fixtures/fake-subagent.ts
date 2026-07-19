/**
 * A fake `spawn` for combinator tests.
 *
 * Combinators must never be tested through a real session: what we assert on
 * is how many subagents were spawned, in what order, and when they were
 * closed - the observable shape of lifetime.
 */

import type { Agent } from "../../src/agent.ts";
import { emptyUsage, type Usage } from "../../src/usage.ts";
import type { Result } from "../../src/result.ts";
import type { SpawnFn } from "../../src/workflows/common.ts";
import type { AskOptions, SpawnOptions, Subagent } from "../../src/subagent.ts";

export type FakeReply = {
	/** Output of this turn. Defaults to echoing the task. */
	output?: string;
	ok?: boolean;
	error?: string;
	usage?: Partial<Usage>;
	delayMs?: number;
};

export type FakeSpawn = {
	spawn: SpawnFn;
	/** One entry per spawn, in order, with the options it was given. */
	spawned: { agent: string; id: string; options: SpawnOptions }[];
	/** Every task received, across all subagents, in call order. */
	asks: { id: string; task: string }[];
	/** The options each `ask` was given, in the same order. */
	askOptions: AskOptions[];
	closed: string[];
	/** Highest number of `ask` calls in flight at once. */
	maxConcurrent: number;
};

/**
 * Builds an injectable `spawn`.
 *
 * `reply` is called per turn so a test can vary the answer - a loop's judge,
 * a branch that fails.
 */
export function fakeSpawn(reply: (task: string, agent: Agent) => FakeReply = () => ({})): FakeSpawn {
	const spawned: { agent: string; id: string; options: SpawnOptions }[] = [];
	const asks: { id: string; task: string }[] = [];
	const askOptions: AskOptions[] = [];
	const closed: string[] = [];
	let inFlight = 0;
	let maxConcurrent = 0;
	let counter = 0;

	const spawn: SpawnFn = async (agent, options) => {
		const id = `${agent.name}#${++counter}`;
		spawned.push({ agent: agent.name, id, options });

		// The fake emits the same events as the real `spawn`. Without that, a
		// reporter wired above a combinator would see nothing here and every
		// display test would pass on a stream that is empty in production.
		const bus = options.bus;
		let lastResult: Result | undefined;
		if (options.onEvent) bus?.subscribe(options.onEvent);
		const lifetime = options.lifetime ?? agent.lifetime ?? "task";
		bus?.emit({ type: "spawn", id, agent: agent.name, lifetime, openInHerdr: options.openInHerdr ?? false });
		bus?.emit({ type: "status", id, status: "idle" });

		const subagent: Subagent = {
			id,
			agent,
			lifetime: options.lifetime ?? "task",
			get usage() {
				return emptyUsage();
			},
			async ask(task, options = {}) {
				asks.push({ id, task });
				askOptions.push(options);
				inFlight++;
				maxConcurrent = Math.max(maxConcurrent, inFlight);
				bus?.emit({ type: "status", id, status: "working", task });
				try {
					const answer = reply(task, agent);
					if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));

					const usage: Usage = { ...emptyUsage(), turns: 1, ...answer.usage };
					const ok = answer.ok ?? true;
					const result: Result = {
						agent: agent.name,
						output: answer.output ?? `${agent.name}(${task})`,
						messages: [],
						usage,
						ok,
					};
					if (!ok) result.error = answer.error ?? "failed";
					lastResult = result;
					bus?.emit({ type: "usage", id, usage });
					bus?.emit({ type: "status", id, status: ok ? "idle" : "blocked" });
					return result;
				} finally {
					inFlight--;
				}
			},
			async close() {
				if (closed.includes(id)) return;
				closed.push(id);
				bus?.emit({ type: "status", id, status: "done" });
				bus?.emit({
					type: "close",
					id,
					result: lastResult ?? { agent: agent.name, output: "", messages: [], usage: emptyUsage(), ok: true },
				});
			},
		};

		return subagent;
	};

	return {
		spawn,
		spawned,
		asks,
		askOptions,
		closed,
		get maxConcurrent() {
			return maxConcurrent;
		},
	};
}

/** A minimal agent, built in memory. */
export function testAgent(name: string, extra: Partial<Agent> = {}): Agent {
	return {
		name,
		description: `${name} for tests`,
		systemPrompt: `You are ${name}.`,
		source: "user",
		filePath: `<memory:${name}>`,
		...extra,
	};
}
