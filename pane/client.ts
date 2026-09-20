/**
 * The pane's end of the mirror's wire: connect, attach, read lines, speak.
 *
 * The mirror may still be coming up when the pane starts - the split opens,
 * a shell starts, then this - so a refused connection is retried a few times
 * before it is given up on. Everything else is one JSON object per line.
 */

import { createConnection, type Socket } from "node:net";
import type { MirrorIn, MirrorOut } from "../src/mirror.ts";

/** A connection to one subagent's mirror. */
export type MirrorClient = {
	/** Sends a steer or a stop. Dropped silently once the line is gone. */
	send(input: MirrorIn): void;
	/** Hangs up. The subagent does not notice. */
	close(): void;
};

/** What the client needs, and what it reports. */
export type ClientOptions = {
	/** The mirror's socket path. */
	socket: string;
	/** The subagent to attach to. */
	id: string;
	/** One parsed line from the mirror. */
	onLine(line: MirrorOut): void;
	/** The line went, or never came: `reason` says which. */
	onEnd(reason?: string): void;
	/** Connection attempts before giving up. Defaults to 15, 200 ms apart. */
	retries?: number;
};

const RETRY_MS = 200;

/** Attaches to `id` over `socket`. Never throws: what went wrong reaches `onEnd`. */
export function attachTo(options: ClientOptions): MirrorClient {
	let socket: Socket | undefined;
	let attempts = 0;
	let closed = false;
	let buffer = "";
	let ended = false;
	const end = (reason?: string) => {
		if (ended) return;
		ended = true;
		options.onEnd(reason);
	};

	const connect = () => {
		attempts += 1;
		let connected = false;
		socket = createConnection(options.socket);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			connected = true;
			socket?.write(`${JSON.stringify({ attach: options.id })}\n`);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const raw = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					options.onLine(JSON.parse(raw) as MirrorOut);
				} catch {
					// one unreadable line is not a reason to lose the pane
				}
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			// Not there yet, or not there at all: only time tells the two apart.
			const retryable = error.code === "ECONNREFUSED" || error.code === "ENOENT";
			if (retryable && !closed && attempts < (options.retries ?? 15)) {
				setTimeout(connect, RETRY_MS);
				return;
			}
			end(error.message);
		});
		// A connection that was up and went is the subagent closing, or the
		// mirror's process ending; one that never came up is the error's.
		socket.on("close", () => {
			if (connected && !closed) end();
		});
	};
	connect();

	return {
		send(input) {
			try {
				socket?.write(`${JSON.stringify(input)}\n`);
			} catch {
				// the line is gone; the footer already says so
			}
		},
		close() {
			closed = true;
			socket?.destroy();
		},
	};
}
