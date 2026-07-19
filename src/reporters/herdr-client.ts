/**
 * Detection and transport for herdr's socket API. Nothing else lives here.
 *
 * Ported from the integration herdr installs into pi itself
 * (`~/.pi/agent/extensions/herdr-agent-state.ts`, `HERDR_INTEGRATION_ID=pi`):
 * that file is the reference implementation, proven against this exact server,
 * and there is no reason to invent a second dialect.
 */

import { createConnection } from "node:net";

/** The three variables herdr injects into a pane. All three, or nothing. */
export type HerdrEnv = {
	socketPath: string;
	paneId: string;
};

/**
 * Detects a live herdr pane.
 *
 * Returns `undefined` when any of the three markers is missing - which is the
 * normal case outside herdr, not an error. Callers fall back silently: no
 * warning is ever printed just because herdr is not there.
 */
export function detectHerdr(env: NodeJS.ProcessEnv = process.env): HerdrEnv | undefined {
	if (env.HERDR_ENV !== "1") return undefined;
	const socketPath = env.HERDR_SOCKET_PATH;
	const paneId = env.HERDR_PANE_ID;
	if (!socketPath || !paneId) return undefined;
	return { socketPath, paneId };
}

/**
 * Sends one request to herdr. Resolves with the response, or `undefined` when
 * the call could not be delivered.
 *
 * It **never rejects**. A herdr that stopped answering must not take a workflow
 * down with it - the display is an observer, never a participant.
 */
export type HerdrSend = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Source id under which we report. Distinct from the pi integration's `herdr:pi`. */
export const HERDR_SOURCE = "pi-subagent";

/**
 * Builds a sender bound to a herdr socket.
 *
 * One connection per request, closed as soon as the first response arrives -
 * that is what the reference implementation does, and the server expects it.
 * A first attempt at 500 ms, then one retry at 1500 ms, then we give up quietly.
 */
export function createHerdrSend(env: HerdrEnv): HerdrSend {
	return async (method, params) => {
		const request = { id: `${HERDR_SOURCE}:${nextSeq()}`, method, params };
		const first = await attempt(env.socketPath, request, 500);
		if (first.delivered) return first.response;
		const second = await attempt(env.socketPath, request, 1500);
		return second.response;
	};
}

/**
 * A monotonic counter, used both for request ids and for herdr's `seq`
 * ordering field. Seeded from the clock like the pi integration, so that two
 * processes reporting on the same pane do not collide on low numbers.
 */
let seq = Date.now() * 1000;

export function nextSeq(): number {
	return ++seq;
}

type Attempt = { delivered: boolean; response?: unknown };

function attempt(socketPath: string, request: unknown, timeoutMs: number): Promise<Attempt> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: Attempt) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};

		const socket = createConnection(socketPath);
		socket.on("error", () => finish({ delivered: false }));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => finish({ delivered: true, response: parse(chunk) }));
		socket.on("end", () => finish({ delivered: false }));

		const timer = setTimeout(() => finish({ delivered: false }), timeoutMs);
		// Never keep the process alive for a display concern.
		timer.unref?.();
	});
}

function parse(chunk: Buffer): unknown {
	try {
		// The server answers one JSON object per line; we only ever send one
		// request per connection, so the first line is ours.
		const line = chunk.toString("utf8").split("\n", 1)[0] ?? "";
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** Pulls the pane id out of an `agent.start` response, if there is one. */
export function paneIdOf(response: unknown): string | undefined {
	const agent = (response as { result?: { agent?: { pane_id?: unknown } } })?.result?.agent;
	return typeof agent?.pane_id === "string" ? agent.pane_id : undefined;
}
