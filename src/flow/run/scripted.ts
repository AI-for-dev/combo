/**
 * A `SessionPort` that answers from a script: what a dry run's subagents run
 * on in place of a model.
 *
 * Narrower than the test fake, on purpose: no delay, no token, no steer.
 * What it keeps is what the runner reads, so a scripted answer takes the
 * path a real one would. A typed value goes through the real `submit` tool
 * and a verdict through the real `verdict` tool, a provider failure is a turn
 * that comes back with an error, a timeout expires the attempt's deadline and
 * waits for the signal it fires, and a schema failure is a turn that calls
 * nothing.
 */

import type { AgentMessage, CreateSessionOptions, SessionPort, ToolDefinition, Turn } from "../../session.ts";
import { emptyUsage } from "../../usage.ts";

/** What one scripted turn does: say a text, call one of its tools with `args`, or fail as `fail` says. */
export type ScriptedTurn = { readonly say: string } | { readonly call: string; readonly args: unknown } | { readonly fail: "provider" | "timeout" | "schema" };

/** A scripted session, told before each turn what that turn does and how to expire the deadline it runs under. */
export type ScriptedSession = SessionPort & { stage(turn: ScriptedTurn, expire: () => void): void };

/** A session for a subagent spawned with `options`, answering whatever it is staged with. */
export function scriptedSession(options: CreateSessionOptions): ScriptedSession {
	const transcript: AgentMessage[] = [];
	let staged: { turn: ScriptedTurn; expire: () => void } | undefined;

	return {
		model: options.model,
		stage(turn, expire) {
			staged = { turn, expire };
		},
		async ask(text, { signal, onStreamed }) {
			if (staged === undefined) throw new Error("A scripted session was asked a turn nobody staged");
			const { turn, expire } = staged;
			staged = undefined;
			const messages: AgentMessage[] = [{ role: "user", content: text } as AgentMessage];
			// A script spends nothing, and says so the way a provider reporting nothing does.
			const answer = (said: string, error?: string): Turn => {
				messages.push({ role: "assistant", content: [{ type: "text", text: said }] } as unknown as AgentMessage);
				transcript.push(...messages);
				return { messages, text: said, error, usage: emptyUsage() };
			};
			if ("say" in turn) {
				onStreamed?.({ type: "text", delta: turn.say });
				return answer(turn.say);
			}
			if ("call" in turn) {
				onStreamed?.({ type: "tool", name: turn.call, args: turn.args });
				await call(options.customTools?.find((tool) => tool.name === turn.call), turn.call, turn.args);
				return answer("");
			}
			if (turn.fail === "timeout") {
				const fired = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				expire();
				await fired;
				return answer("", "aborted");
			}
			return turn.fail === "provider" ? answer("", "scripted provider failure") : answer("");
		},
		steer: async () => "idle",
		watch: () => () => undefined,
		transcript: () => transcript,
		close() {},
	};
}

/**
 * Calls `tool` as pi does once a model asked for it. The context is pi's own
 * and neither `submit` nor `verdict` reads any, which is the one thing that
 * lets a script call them.
 */
async function call(tool: ToolDefinition | undefined, name: string, params: unknown): Promise<void> {
	if (tool === undefined) throw new Error(`A scripted turn calls \`${name}\`, and the subagent was offered no such tool`);
	await (tool.execute as (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>)("scripted", params);
}
