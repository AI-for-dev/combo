/**
 * A scriptable `SessionPort`. This is what makes the whole suite run offline.
 *
 * It plays turns as the port hands them back: each with its own messages, its
 * answer, its error and what it cost, so a script says what one turn did and
 * nothing adds it up. What pi does underneath, cumulative counters and
 * compaction included, is `sessionPort()`'s, and `pi-session.ts` stands in for
 * pi there. Its turn really ends when the signal fires: a fake that slept
 * through an abort would let a broken timeout look like a working one.
 */

import type { Agent } from "../../src/agent.ts";
import type { AgentMessage, CreateSession, CreateSessionOptions, SessionPort, TurnControl } from "../../src/session.ts";
import { emptyUsage } from "../../src/usage.ts";

export type Turn = {
	/** Assistant text for this turn. */
	text?: string;
	/** Tokens this turn cost. */
	tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
	/** The context level the turn leaves. The last one given stands until another is. */
	contextTokens?: number;
	/** Fails the turn with this error, as a session reports a turn that threw or ended on a failing `stopReason`. Its tokens still count. */
	error?: string;
	/** Milliseconds the turn takes, cut short by the signal. */
	delayMs?: number;
	/** Tool calls streamed during the turn. */
	tools?: { name: string; args?: unknown }[];
};

export type FakeSession = SessionPort & {
	/** What each turn was asked, in order. */
	readonly prompts: string[];
	/** What was steered into it, in order. */
	readonly steers: string[];
	readonly closed: boolean;
	/** How many turns the signal cut. */
	readonly aborted: number;
};

/** Builds a session that plays `turns`, in order. */
export function fakeSession(turns: Turn[] = []): FakeSession {
	const transcript: AgentMessage[] = [];
	const prompts: string[] = [];
	const steers: string[] = [];
	let index = 0;
	let closed = false;
	let aborted = 0;
	let contextTokens: number | undefined;
	/** Adds a message to the turn in flight. Absent between turns. */
	let inTurn: ((message: AgentMessage) => void) | undefined;

	async function ask(text: string, { signal, onStreamed }: TurnControl) {
		prompts.push(text);
		const turn: Turn = turns[index++] ?? {};
		const messages: AgentMessage[] = [];
		const add = (message: AgentMessage) => {
			messages.push(message);
			transcript.push(message);
		};
		const cut = () => aborted++;
		signal.addEventListener("abort", cut, { once: true });
		inTurn = add;
		try {
			add({ role: "user", content: text } as AgentMessage);
			if (turn.delayMs) await sleep(turn.delayMs, signal);
			for (const tool of turn.tools ?? []) onStreamed?.({ type: "tool", name: tool.name, args: tool.args });
			if (turn.text) onStreamed?.({ type: "text", delta: turn.text });
			add({ role: "assistant", content: [{ type: "text", text: turn.text ?? "" }] } as unknown as AgentMessage);
		} finally {
			inTurn = undefined;
			signal.removeEventListener("abort", cut);
		}
		if (turn.contextTokens !== undefined) contextTokens = turn.contextTokens;
		return {
			messages,
			text: turn.text ?? "",
			error: signal.aborted ? "aborted" : turn.error,
			usage: { ...emptyUsage(), ...turn.tokens, cost: turn.cost ?? 0, contextTokens },
		};
	}

	return {
		ask,
		async steer(text) {
			if (!inTurn) return "idle";
			steers.push(text);
			inTurn({ role: "user", content: text } as AgentMessage);
			return "queued";
		},
		watch: () => () => undefined,
		transcript: () => transcript,
		close() {
			closed = true;
		},
		get prompts() {
			return prompts;
		},
		get steers() {
			return steers;
		},
		get closed() {
			return closed;
		},
		get aborted() {
			return aborted;
		},
	};
}

/** Waits `ms`, or until `signal` fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/** A `createSession` that hands out fakes and records them, in spawn order. */
export function fakeSessionFactory(turnsPerSpawn: Turn[][] | Turn[] = []) {
	const created: FakeSession[] = [];
	/** What each spawn asked for - this is how a test sees the *effective* model. */
	const requested: { agent: Agent; options: CreateSessionOptions }[] = [];
	const isNested = Array.isArray(turnsPerSpawn[0]);

	const createSession: CreateSession = async (agent, options) => {
		requested.push({ agent, options });
		const turns = (isNested ? (turnsPerSpawn as Turn[][])[created.length] : (turnsPerSpawn as Turn[])) ?? [];
		const session = fakeSession(turns);
		created.push(session);
		return session;
	};

	return { createSession, created, requested };
}
