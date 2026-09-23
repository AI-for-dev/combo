/**
 * A `SessionPort` that answers from a script: what a dry run's subagents run
 * on in place of a model.
 *
 * Narrower than the test fake, on purpose: no delay, no token, no steer.
 * What it keeps is what the runner reads, so a scripted answer takes the
 * path a real one would. A typed value goes through the real `submit` tool,
 * a provider failure ends the turn on a failing `stopReason`, a timeout fires
 * the attempt's deadline and waits for the abort it causes, and a schema
 * failure is a turn that submits nothing.
 */

import type { AgentMessage, CreateSessionOptions, SessionEvent, SessionPort, ToolDefinition } from "../../session.ts";
import { SUBMIT_TOOL } from "./submit.ts";

/** What one scripted turn does: say a text, submit a call's parameters, or fail as `fail` says. */
export type ScriptedTurn = { readonly say: string } | { readonly submit: unknown } | { readonly fail: "provider" | "timeout" | "schema" };

/** A scripted session, told before each turn what that turn does and which deadline it runs under. */
export type ScriptedSession = SessionPort & { stage(turn: ScriptedTurn, deadline: AbortController): void };

type Stats = ReturnType<SessionPort["getSessionStats"]>;

/** A session for a subagent spawned with `options`, answering whatever it is staged with. */
export function scriptedSession(options: CreateSessionOptions): ScriptedSession {
	const listeners = new Set<(event: SessionEvent) => void>();
	const messages: AgentMessage[] = [];
	const submit = options.customTools?.find((tool) => tool.name === SUBMIT_TOOL);
	let staged: { turn: ScriptedTurn; deadline: AbortController } | undefined;
	let streaming = false;
	let cut: (() => void) | undefined;

	const emit = (event: SessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const answer = (text: string, stopReason = "stop", errorMessage?: string) => {
		messages.push({ role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage } as unknown as AgentMessage);
		emit({ type: "turn_end" });
	};

	async function turn(): Promise<void> {
		if (staged === undefined) throw new Error("A scripted session was asked a turn nobody staged");
		const { turn, deadline } = staged;
		staged = undefined;
		if ("say" in turn) {
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: turn.say } });
			return answer(turn.say);
		}
		if ("submit" in turn) {
			emit({ type: "tool_execution_start", toolName: SUBMIT_TOOL, args: turn.submit });
			await call(submit, turn.submit);
			return answer("");
		}
		if (turn.fail === "timeout") {
			const aborted = new Promise<void>((resolve) => (cut = resolve));
			deadline.abort();
			await aborted;
			return answer("", "aborted");
		}
		return turn.fail === "provider" ? answer("", "error", "scripted provider failure") : answer("");
	}

	return {
		get messages() {
			return messages;
		},
		get isStreaming() {
			return streaming;
		},
		model: options.model === undefined ? undefined : { id: options.model },
		stage(turn, deadline) {
			staged = { turn, deadline };
		},
		async prompt(text) {
			messages.push({ role: "user", content: text } as AgentMessage);
			streaming = true;
			try {
				await turn();
			} finally {
				streaming = false;
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSessionStats: zero,
		getContextUsage: () => undefined,
		async abort() {
			cut?.();
		},
		async steer() {},
		dispose() {
			listeners.clear();
		},
	};
}

/**
 * Calls `tool` as pi does once a model asked for it. The context is pi's own
 * and the submit tool reads none, which is the one thing that lets a script
 * call it.
 */
async function call(tool: ToolDefinition | undefined, params: unknown): Promise<void> {
	if (tool === undefined) throw new Error(`A scripted turn submits, and the subagent was offered no \`${SUBMIT_TOOL}\` tool`);
	await (tool.execute as (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>)("scripted", params);
}

/** A script spends nothing, and says so the way a provider reporting nothing does. */
function zero(): Stats {
	return { sessionFile: undefined, sessionId: "scripted", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } as Stats;
}
