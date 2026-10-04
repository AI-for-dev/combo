/**
 * A scriptable stand-in for pi's `AgentSession`, for the tests of what
 * `sessionPort()` reads of it and of the mirror, which forwards pi's events.
 *
 * It reproduces the behaviours of pi that are easy to get wrong:
 * `getSessionStats()` is **cumulative**, and `messages` **grows** with every
 * turn, until a compaction rebuilds it shorter in the middle of one. A fake
 * that returned per-turn stats would hide the very bug the delta arithmetic
 * exists to prevent, and one that only ever grew would hide a turn that reads
 * its answer by position. Each message it adds ends with a `message_end`, as
 * pi's do; the summary a compaction writes does not.
 */

import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, PiSession, SessionEvent } from "../../src/session.ts";

export type PiTurn = {
	/** Assistant text for this turn. */
	text?: string;
	/** Tokens *added* by this turn - the fake accumulates them itself. */
	tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
	contextTokens?: number;
	/** Makes `prompt()` reject. */
	throws?: string;
	/** Makes the turn end on a `stopReason` other than `stop`, without throwing: `length` is pi's output limit. */
	stopReason?: "error" | "aborted" | "length";
	/** Milliseconds spent in `prompt()`, to observe concurrency. */
	delayMs?: number;
	/** Tool calls emitted during the turn. */
	tools?: { name: string; args?: unknown }[];
	/** Compacts before the answer, as pi does mid-run: `messages` comes back shorter, a summary first. */
	compacts?: boolean;
};

export type FakePiSession = PiSession & {
	readonly prompts: string[];
	/** What was steered into it, in order. */
	readonly steers: string[];
	readonly disposed: boolean;
	readonly aborted: number;
};

/** Builds a session that replays `turns`, in order. */
export function fakePiSession(turns: PiTurn[] = []): FakePiSession {
	const listeners = new Set<(event: SessionEvent) => void>();
	const messages: AgentMessage[] = [];
	const prompts: string[] = [];
	const steers: string[] = [];
	let streaming = false;

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
	const add = (message: AgentMessage) => {
		messages.push(message);
		emit({ type: "message_end", message });
	};

	const session: FakePiSession = {
		get messages() {
			return messages;
		},
		get prompts() {
			return prompts;
		},
		get steers() {
			return steers;
		},
		get isStreaming() {
			return streaming;
		},

		async steer(text) {
			steers.push(text);
			add({ role: "user", content: text } as AgentMessage);
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
			streaming = true;
			try {
				await runTurn(text);
			} finally {
				streaming = false;
			}
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

	/** One scripted turn. Apart from `prompt` so `isStreaming` brackets all of it. */
	async function runTurn(text: string) {
		const turn: PiTurn = turns[index++] ?? {};

		add({ role: "user", content: text } as AgentMessage);

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

		if (turn.compacts) {
			messages.splice(0, messages.length, { role: "compactionSummary", summary: "what came before" } as unknown as AgentMessage);
		}

		const stopReason = abortCurrent ? "aborted" : (turn.stopReason ?? "stop");
		abortCurrent = false;
		add({
			role: "assistant",
			content: [{ type: "text", text: turn.text ?? "" }],
			stopReason,
			errorMessage: stopReason === "error" ? "boom" : undefined,
		} as unknown as AgentMessage);
		emit({ type: "turn_end" });
	}

	return session;
}
