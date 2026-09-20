/**
 * A fake `spawn` for combinator tests.
 *
 * Combinators must never be tested through a real session: what we assert on
 * is how many subagents were spawned, in what order, and when they were
 * closed - the observable shape of lifetime.
 */

import type { Agent } from "../../src/agent.ts";
import { emptyUsage, type Usage } from "../../src/usage.ts";
import { failed, succeeded, type Result } from "../../src/result.ts";
import type { ToolDefinition } from "../../src/session.ts";
import type { SpawnFn } from "../../src/workflows/options.ts";
import { toolsOffered, type AskOptions, type SpawnOptions, type Subagent } from "../../src/subagent.ts";

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
	/** Every export asked for, in order. */
	exported: { id: string; dir: string }[];
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
 * a branch that fails. It receives the options the subagent was spawned with,
 * so a turn can act through a tool the workflow offered, and it may be async
 * because acting through one is.
 */
/** What a spawn was offered, whichever shape the caller used - the library's own reading of it. */
export function offeredTools(options: SpawnOptions, id: string = "holder#1"): ToolDefinition[] {
	return toolsOffered(options.customTools, id);
}

export function fakeSpawn(
	reply: (task: string, agent: Agent, options: SpawnOptions) => FakeReply | Promise<FakeReply> = () => ({}),
): FakeSpawn {
	const spawned: { agent: string; id: string; options: SpawnOptions }[] = [];
	const asks: { id: string; task: string }[] = [];
	const askOptions: AskOptions[] = [];
	const closed: string[] = [];
	const exported: { id: string; dir: string }[] = [];
	let inFlight = 0;
	let maxConcurrent = 0;
	let counter = 0;

	const spawn: SpawnFn = async (agent, options) => {
		const id = `${agent.name}#${++counter}`;
		// Named apart from `ask`'s own `options`, which shadows it.
		const spawnOptions = options;
		spawned.push({ agent: agent.name, id, options });

		// The fake emits the same events as the real `spawn`. Without that, a
		// reporter wired above a combinator would see nothing here and every
		// display test would pass on a stream that is empty in production.
		const bus = options.bus;
		let lastResult: Result | undefined;
		let stopped = false;
		/** Resolves the in-flight delay, so `stop()` really cuts a turn short. */
		let interrupt: (() => void) | undefined;
		if (options.onEvent) bus?.subscribe(options.onEvent);
		const lifetime = options.lifetime ?? agent.lifetime ?? "task";
		bus?.emit({
			type: "spawn",
			id,
			agent: agent.name,
			lifetime,
			openInHerdr: options.openInHerdr ?? false,
			order: counter,
			parentId: options.parentId,
		});
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
					// Like the real `ask`: a turn that cannot run is refused, and a
					// turn that is stopped mid-flight is cut short rather than slept
					// through. A fake that answered anyway would let a stop switch
					// that reaches nothing look like one that works.
					const cutShort = () => (stopped ? "stopped" : options.signal?.aborted ? "aborted" : undefined);
					let error = cutShort();

					const answer = error ? ({} as FakeReply) : await reply(task, agent, spawnOptions);
					if (!error && answer.delayMs) {
						const onAbort = () => interrupt?.();
						options.signal?.addEventListener("abort", onAbort, { once: true });
						await new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, answer.delayMs);
							interrupt = () => {
								clearTimeout(timer);
								resolve();
							};
						});
						options.signal?.removeEventListener("abort", onAbort);
						interrupt = undefined;
						error = cutShort();
					}

					if (error) {
						const result = failed(agent.name, error);
						lastResult = result;
						bus?.emit({ type: "status", id, status: "blocked" });
						return result;
					}

					const usage: Usage = { ...emptyUsage(), turns: 1, ...answer.usage };
					const ok = answer.ok ?? true;
					const output = answer.output ?? `${agent.name}(${task})`;
					// A failed turn keeps what it said, as the real one keeps its messages.
					const result: Result = ok ? succeeded(agent.name, output, usage) : { ...failed(agent.name, answer.error ?? "failed", usage), output };
					lastResult = result;
					bus?.emit({ type: "usage", id, usage });
					bus?.emit({ type: "status", id, status: ok ? "idle" : "blocked" });
					return result;
				} finally {
					inFlight--;
				}
			},
			stop() {
				stopped = true;
				interrupt?.();
			},

			async export(dir = options.exportDir) {
				if (!dir) return { id, error: "no export directory" };
				exported.push({ id, dir });
				return { id, jsonl: `${dir}/${id.replace("#", "-")}.jsonl` };
			},
			async close() {
				if (closed.includes(id)) return;
				// The real `close()` exports before it disposes; a workflow test
				// that asserts on exports must see the same thing here.
				if (options.exportDir) await subagent.export(options.exportDir);
				closed.push(id);
				bus?.emit({ type: "status", id, status: "done" });
				bus?.emit({
					type: "close",
					id,
					result: lastResult ?? succeeded(agent.name, ""),
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
		exported,
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
