/**
 * A scriptable `SessionPort`. This is what makes the whole suite run offline.
 *
 * It reproduces the two behaviours of pi that are easy to get wrong:
 * `getSessionStats()` is **cumulative**, and `messages` **grows** with every
 * turn. A fake that returned per-turn stats would hide the very bug the
 * delta arithmetic exists to prevent.
 */

import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, SessionEvent, SessionPort } from "../../src/session.ts";

export type Turn = {
	/** Assistant text for this turn. */
	text?: string;
	/** Tokens *added* by this turn - the fake accumulates them itself. */
	tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
	contextTokens?: number;
	/** Makes `prompt()` reject. */
	throws?: string;
	/** Makes the turn end on a failing `stopReason`, without throwing. */
	stopReason?: "error" | "aborted";
	/** Milliseconds spent in `prompt()`, to observe concurrency. */
	delayMs?: number;
	/** Tool calls emitted during the turn. */
	tools?: { name: string; args?: unknown }[];
};

export type FakeSession = SessionPort & {
	readonly prompts: string[];
	readonly disposed: boolean;
	readonly aborted: number;
};

/** Builds a session that replays `turns`, in order. */
export function fakeSession(turns: Turn[] = []): FakeSession {
	const listeners = new Set<(event: SessionEvent) => void>();
	const messages: AgentMessage[] = [];
	const prompts: string[] = [];

	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let contextTokens: number | undefined;
	let index = 0;
	let disposed = false;
	let aborted = 0;
	let abortCurrent = false;
	/** Resolves the in-flight delay, so `abort()` really cuts a turn short. */
	let interrupt: (() => void) | undefined;

	const emit = (event: SessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session: FakeSession = {
		get messages() {
			return messages;
		},
		get prompts() {
			return prompts;
		},
		get disposed() {
			return disposed;
		},
		get aborted() {
			return aborted;
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		async prompt(text) {
			prompts.push(text);
			const turn: Turn = turns[index++] ?? {};

			messages.push({ role: "user", content: text } as AgentMessage);

			// A real `abort()` cuts the turn short. A fake that slept through it
			// would let a broken timeout look like a working one.
			if (turn.delayMs) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, turn.delayMs);
					interrupt = () => {
						clearTimeout(timer);
						resolve();
					};
				});
				interrupt = undefined;
			}

			for (const tool of turn.tools ?? []) {
				emit({ type: "tool_execution_start", toolName: tool.name, args: tool.args });
			}
			if (turn.text) {
				emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: turn.text } });
			}

			// Tokens are billed even when the turn goes on to fail.
			total.input += turn.tokens?.input ?? 0;
			total.output += turn.tokens?.output ?? 0;
			total.cacheRead += turn.tokens?.cacheRead ?? 0;
			total.cacheWrite += turn.tokens?.cacheWrite ?? 0;
			total.cost += turn.cost ?? 0;
			if (turn.contextTokens !== undefined) contextTokens = turn.contextTokens;

			if (turn.throws) throw new Error(turn.throws);

			const stopReason = abortCurrent ? "aborted" : (turn.stopReason ?? "stop");
			abortCurrent = false;
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: turn.text ?? "" }],
				stopReason,
				errorMessage: stopReason === "error" ? "boom" : undefined,
			} as unknown as AgentMessage);
			emit({ type: "turn_end" });
		},

		getSessionStats(): SessionStats {
			return {
				sessionFile: undefined,
				sessionId: "fake",
				userMessages: prompts.length,
				assistantMessages: prompts.length,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: messages.length,
				tokens: { ...total, total: total.input + total.output },
				cost: total.cost,
				contextUsage: contextTokens === undefined ? undefined : { tokens: contextTokens, contextWindow: 200_000, percent: 0 },
			};
		},

		getContextUsage() {
			return this.getSessionStats().contextUsage;
		},

		async abort() {
			aborted++;
			abortCurrent = true;
			interrupt?.();
		},

		dispose() {
			disposed = true;
			listeners.clear();
		},
	};

	return session;
}

/** A `createSession` that hands out fakes and records them, in spawn order. */
export function fakeSessionFactory(turnsPerSpawn: Turn[][] | Turn[] = []) {
	const created: FakeSession[] = [];
	const isNested = Array.isArray(turnsPerSpawn[0]);

	const createSession = async () => {
		const turns = (isNested ? (turnsPerSpawn as Turn[][])[created.length] : (turnsPerSpawn as Turn[])) ?? [];
		const session = fakeSession(turns);
		created.push(session);
		return session;
	};

	return { createSession, created };
}
