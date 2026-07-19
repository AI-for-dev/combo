/**
 * A subagent: a live session, a memory, a state.
 *
 * This is the heart of the library. Everything else - `run`, `chain`,
 * `fanOut` - is built on the three methods below: `ask`, `usage`, `close`.
 *
 * The rule that governs this file: **whoever opens, closes**. A `Subagent` is
 * an explicit object with an explicit owner. There is no global session cache
 * hidden anywhere.
 */

import type { Agent, Lifetime } from "./agent.ts";
import { createEventBus, nextSubagentId, type EventBus, type EventListener, type SubagentEvent } from "./events.ts";
import { failed, type Result } from "./result.ts";
import { createDefaultSession, modelLabel, type AgentMessage, type CreateSession, type SessionPort } from "./session.ts";
import { deltaUsage, emptyUsage, snapshotUsage, type Usage } from "./usage.ts";

export type SpawnOptions = {
	/** Overrides the lifetime declared by the agent. Defaults to `"task"`. */
	lifetime?: Lifetime;
	cwd?: string;
	/** Dedicated session directory, required for the session to be exportable. */
	sessionDir?: string;
	/** Subscribed to the event stream for the subagent's whole life. */
	onEvent?: EventListener;
	/** Shared bus, when several subagents must report to the same place. */
	bus?: EventBus;
	/** Session factory. Injection point for tests - defaults to a real pi session. */
	createSession?: CreateSession;
	/**
	 * Give this subagent its own herdr split, when running inside herdr.
	 *
	 * Opt-in per subagent, like {@link SpawnOptions.lifetime}, and resolved the
	 * same way: this argument wins over the agent's frontmatter, which wins over
	 * `false`. A fan-out of twenty branches must not carpet the screen unless
	 * someone asked for it. Outside herdr it is simply ignored.
	 */
	openInHerdr?: boolean;
};

export type AskOptions = {
	/**
	 * Cancels this turn. pi's `prompt()` takes no signal, so we bridge it to
	 * `session.abort()`.
	 */
	signal?: AbortSignal;
	/**
	 * Deadline for this turn, in milliseconds. No default: an `ask` waits
	 * forever unless you say otherwise.
	 *
	 * This matters more than it looks. One `ask` is one `session.prompt()`, and
	 * pi's agent loop is a `while (true)` that runs as long as the model keeps
	 * requesting tools - there is no step cap in pi. A model that hallucinates a
	 * tool name, gets "unknown tool" back and asks again will loop until
	 * something stops it. Nothing will, unless it is this.
	 */
	timeoutMs?: number;
};

/** A living subagent. Its owner is whoever called {@link spawn}. */
export type Subagent = {
	readonly id: string;
	readonly agent: Agent;
	readonly lifetime: Lifetime;
	/** Cumulative measurements since spawn. Read `Result.usage` for a single turn. */
	readonly usage: Usage;
	/** Runs one turn of work. Never throws on a model failure - returns `ok: false`. */
	ask(task: string, options?: AskOptions): Promise<Result>;
	/** Releases the session. Idempotent. */
	close(): Promise<void>;
};

/**
 * Brings an agent to life.
 *
 * The lifetime is **explicit and local**: the argument wins over the agent's
 * frontmatter, which itself wins over the `"task"` default. Persistence is
 * asked for; it is never obtained by accident.
 *
 * The caller owns the returned object and must `close()` it, ideally in a
 * `finally`.
 */
export async function spawn(agent: Agent, options: SpawnOptions = {}): Promise<Subagent> {
	const lifetime = options.lifetime ?? agent.lifetime ?? "task";
	const id = nextSubagentId(agent.name);

	const bus = options.bus ?? createEventBus();
	if (options.onEvent) bus.subscribe(options.onEvent);

	const createSession = options.createSession ?? createDefaultSession;
	const session = await createSession(agent, { cwd: options.cwd, sessionDir: options.sessionDir });

	// Monotonic clock: `Date.now()` jumps when the system clock is adjusted,
	// and a duration must never go backwards.
	const spawnedAt = performance.now();
	const usage: Usage = emptyUsage();
	let closed = false;
	let asking = false;

	// Streaming events are forwarded as they arrive - never buffered until the
	// end of the turn, otherwise the TUI would show an opaque spinner.
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update") {
			const inner = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
			if (inner?.type === "text_delta" && inner.delta) {
				bus.emit({ type: "text", id, delta: inner.delta });
			}
		} else if (event.type === "tool_execution_start") {
			const call = event as { toolName?: string; args?: unknown };
			bus.emit({ type: "tool", id, name: call.toolName ?? "?", args: call.args });
		}
	});

	const openInHerdr = options.openInHerdr ?? agent.openInHerdr ?? false;
	bus.emit({ type: "spawn", id, agent: agent.name, lifetime, openInHerdr, model: modelLabel(session) });
	bus.emit({ type: "status", id, status: "idle" });

	const subagent: Subagent = {
		id,
		agent,
		lifetime,
		get usage() {
			// Wall time keeps running between two `ask` calls: on a persistent
			// agent, the gap between wallMs and busyMs *is* the information.
			return { ...usage, wallMs: performance.now() - spawnedAt };
		},

		async ask(task, askOptions = {}) {
			// Asking a closed subagent is a programming error, not a runtime
			// failure: it must not be swallowed into a failed Result.
			if (closed) throw new Error(`Subagent ${id} is closed: ask() is no longer allowed`);
			if (asking) throw new Error(`Subagent ${id} is already working: ask() calls must be serialised`);
			asking = true;

			const before = readUsage(session);
			const startedAt = performance.now();
			const startIndex = session.messages.length;

			// One signal to watch, whether it comes from the caller, the deadline,
			// or both. The timeout is created here so it starts with the turn.
			const timeout = askOptions.timeoutMs ? AbortSignal.timeout(askOptions.timeoutMs) : undefined;
			const signal = combineSignals(askOptions.signal, timeout);

			// The listener is removed in the `finally`: a signal shared across
			// several `ask` calls would otherwise accumulate listeners.
			const onAbort = () => void session.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			bus.emit({ type: "status", id, status: "working" });

			let error: string | undefined;
			try {
				await session.prompt(task);
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			} finally {
				signal?.removeEventListener("abort", onAbort);
				asking = false;
			}

			const busyMs = performance.now() - startedAt;
			const turn = deltaUsage(before, readUsage(session));
			turn.busyMs = busyMs;
			turn.turns = 1;

			// Even a failed turn counts: a subagent that died after 12k tokens
			// did spend 12k tokens.
			usage.busyMs += busyMs;
			usage.turns += 1;
			usage.input += turn.input;
			usage.output += turn.output;
			usage.cacheRead += turn.cacheRead;
			usage.cacheWrite += turn.cacheWrite;
			usage.cost += turn.cost;
			usage.contextTokens = turn.contextTokens;

			const messages = session.messages.slice(startIndex);
			// A turn can also fail without throwing: pi reports it through the
			// last assistant message's stopReason.
			error ??= stopError(messages);

			// Both look like an abort from pi's side. Say which one it was: a
			// deadline that expired and a caller that changed its mind call for
			// very different reactions. The caller's own signal wins - it is the
			// more specific cause.
			if (error && timeout?.aborted && !askOptions.signal?.aborted) {
				error = `timed out after ${askOptions.timeoutMs}ms`;
			}

			const result: Result = error
				? failed(agent.name, error, turn, messages)
				: { agent: agent.name, output: lastAssistantText(messages), messages, usage: turn, ok: true };

			bus.emit({ type: "usage", id, usage: turn });
			bus.emit({ type: "status", id, status: error ? "blocked" : "idle" });
			return result;
		},

		async close() {
			if (closed) return;
			closed = true;

			// Stats and context are read *before* dispose(): afterwards the
			// session is gone and the numbers with it.
			const finalUsage = { ...usage, wallMs: performance.now() - spawnedAt };
			unsubscribe();
			session.dispose();

			bus.emit({ type: "status", id, status: "done" });
			bus.emit({
				type: "close",
				id,
				result: {
					agent: agent.name,
					output: lastAssistantText(session.messages),
					messages: [],
					usage: finalUsage,
					ok: true,
				},
			});
		},
	};

	return subagent;
}

/**
 * Merges the caller's signal with the deadline, if there is one.
 *
 * Returns the single signal when only one is present, so no needless
 * `AbortSignal.any` wrapper is created on the common path.
 */
function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
	const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	return AbortSignal.any(present);
}

/** Reads the session counters. Never lets a broken provider bring a turn down. */
function readUsage(session: SessionPort): Usage {
	try {
		return snapshotUsage(session.getSessionStats());
	} catch {
		return emptyUsage();
	}
}

/** Concatenates the text of the last assistant message. */
function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message?.role !== "assistant") continue;
		if (!Array.isArray(message.content)) continue;
		return message.content
			.filter((part): part is { type: "text"; text: string } => (part as { type?: string })?.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
	}
	return "";
}

/** Turns a failing `stopReason` into an error message, or `undefined`. */
function stopError(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return message.errorMessage ?? "model error";
		if (message.stopReason === "aborted") return "aborted";
		return undefined;
	}
	return undefined;
}

export type { SubagentEvent };
