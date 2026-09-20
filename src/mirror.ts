/**
 * The mirror: a live subagent's session, on a unix socket.
 *
 * A herdr pane cannot host an in-process subagent, so the pane hosts a client
 * of this instead. The client attaches by id and gets the transcript so far,
 * then pi's own session events as they happen, which is what pi's chat
 * components are written against. It may speak back: a word for the turn in
 * flight, or a stop.
 *
 * This is a port of the core, beside `ask.ts` and `verify.ts`, not a reporter:
 * a reporter only reads the stream, and the keyboard reaches the session. It
 * is still opt-in by the act that opens a pane - a subagent nobody attached to
 * is a subagent nobody spoke to, and the workflow runs identically.
 *
 * One server per process, listening only once something asks where it is, and
 * gone with the last subagent. Registration itself costs a map entry, so every
 * subagent registers and a test suite never touches a socket.
 */

import * as fs from "node:fs";
import { createServer, type Server } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { EventBus, SubagentEvent } from "./events.ts";
import { broadcast, hangUp, serve, type Mirrors } from "./mirror-wire.ts";
import type { SessionEvent, SessionPort } from "./session.ts";

/** What the mirror needs from a live subagent. Registered by `spawn`. */
export type Mirrored = {
	/** The id a client attaches by, e.g. `scout#1`. */
	id: string;
	/** The definition's name, for the pane's header. */
	agent: string;
	/** The model pi resolved, when it has. */
	model?: string;
	/** Where its tools run - pi's tool renderers want it to shorten paths. */
	cwd: string;
	/** The session itself: its transcript, its events, its steer. */
	session: SessionPort;
	/** Its run's bus: a steer is emitted there, so the record holds it. */
	bus: EventBus;
	/** Its stop switch, the one thing that is safe at any moment. */
	stop(): void;
};

/** The first line a client sends. */
export type Attach = {
	/** The id of the subagent to watch. */
	attach: string;
};

/** What a client may say after attaching. */
export type MirrorIn = { type: "steer"; text: string } | { type: "abort" };

/**
 * What a client receives, one JSON object per line.
 *
 * `attached` comes first and names the pi package this process runs, so a
 * client draws with the same components that produced the events. Then one
 * `message` per transcript entry, then pi's own events as they are (their
 * `type` is pi's), interleaved with `status`, `usage`, `steer` and `close`
 * from the run's stream.
 */
export type MirrorOut =
	| { type: "attached"; id: string; agent: string; model?: string; cwd: string; pi: string }
	| { type: "message"; message: unknown }
	| { type: "refused"; reason: string }
	| { type: "error"; message: string }
	| SessionEvent
	| SubagentEvent;

/**
 * Why a steer on an idle subagent is turned down rather than queued.
 *
 * Measured: pi delivers a steer queued while idle with the next `prompt()`
 * and the model answers the steer instead of the task, and a follow-up is
 * answered inside the next `prompt()` after the task, so the workflow reads
 * the person's exchange back as its own result. Neither is a turn the pane
 * can be allowed to add to a run.
 */
export const REFUSED_IDLE = "between tasks - it can only be steered while it works";

/** How long the latest partial message waits before it goes out. */
const UPDATE_EVERY_MS = 50;

const registry = new Map<string, Mirrored>();
let server: Server | undefined;

/**
 * Where the mirror listens. Starts it if it was not.
 *
 * The path is decided by the process, not by a subagent, which is why it is
 * asked for here and does not ride on the `spawn` event: a reporter opening a
 * pane needs it once, and the same path serves every subagent alive.
 */
export function mirrorSocket(): string {
	const socketPath = path.join(os.tmpdir(), `combo-${process.pid}.sock`);
	if (!server) {
		try {
			fs.rmSync(socketPath, { force: true });
		} catch {
			// a stale socket from a dead process; listen will say if it is still there
		}
		server = createServer((socket) => serve(socket, mirrors));
		server.on("error", () => undefined);
		server.listen(socketPath);
		// A window on a run must never keep the run's process alive.
		server.unref();
	}
	return socketPath;
}

/** Registers a live subagent. Returns the unregistration, idempotent. */
export function registerMirror(mirrored: Mirrored): () => void {
	registry.set(mirrored.id, mirrored);
	let live = true;

	const unregister = () => {
		if (!live) return;
		live = false;
		offBus();
		offSession();
		registry.delete(mirrored.id);
		hangUp(mirrored.id);
		if (registry.size === 0) stopServer();
	};

	const send = (out: MirrorOut) => broadcast(mirrored.id, out);

	// The latest partial message, held back: it arrives per token and carries the
	// whole message so far, and a terminal repaints no faster than this anyway.
	let pending: SessionEvent | undefined;
	let timer: NodeJS.Timeout | undefined;
	const flush = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (pending) send(pending);
		pending = undefined;
	};

	const offSession = mirrored.session.subscribe((event) => {
		if (event.type === "message_update") {
			pending = event;
			if (!timer) {
				timer = setTimeout(flush, UPDATE_EVERY_MS);
				timer.unref?.();
			}
			return;
		}
		// Anything else goes out after what it follows, or a tool call would be
		// drawn before the text that asked for it.
		flush();
		send(event);
	});

	const offBus = mirrored.bus.subscribe((event) => {
		if (event.id !== mirrored.id) return;
		switch (event.type) {
			case "status":
			case "usage":
			case "steer":
				flush();
				send(event);
				break;
			case "close":
				flush();
				send(event);
				unregister();
				break;
		}
	});

	return unregister;
}

function stopServer() {
	server?.close();
	server = undefined;
}

/** What the wire needs from here: who is registered, and what a word does. */
const mirrors: Mirrors = {
	find: (id) => registry.get(id),

	hello: (mirrored) => ({
		type: "attached",
		id: mirrored.id,
		agent: mirrored.agent,
		model: mirrored.model,
		cwd: mirrored.cwd,
		pi: piPackage(),
	}),

	async act(mirrored, input, reply) {
		try {
			if (input.type === "abort") {
				mirrored.stop();
				return;
			}
			if (input.type === "steer" && typeof input.text === "string") {
				if (!mirrored.session.isStreaming) {
					reply({ type: "refused", reason: REFUSED_IDLE });
					return;
				}
				await mirrored.session.steer(input.text);
				mirrored.bus.emit({ type: "steer", id: mirrored.id, text: input.text });
			}
		} catch {
			// a refusal from pi is not the run's problem either
		}
	},
};

/**
 * The pi package this process runs, as a URL a client can import.
 *
 * The events a client draws come from this pi, so the components reading them
 * have to be this pi's too - `node_modules` next to the client may hold
 * another version, and a message shape moved between two patch releases once.
 */
function piPackage(): string {
	try {
		return import.meta.resolve("@earendil-works/pi-coding-agent");
	} catch {
		return "";
	}
}
