/**
 * The mirror's wire: one JSON object per line, both ways.
 *
 * `mirror.ts` decides who can be attached to and what a client's word does;
 * this file only carries lines between a socket and that decision. Nothing
 * here may throw into the process: a client sending garbage has its connection
 * closed, and the run never hears of it.
 */

import type { Socket } from "node:net";
import type { Attach, MirrorIn, MirrorOut, Mirrored } from "./mirror.ts";

/** What the wire asks of the mirror, so this file holds no registry of its own. */
export type Mirrors = {
	/** The subagent registered under `id`, if any. */
	find(id: string): Mirrored | undefined;
	/** What an attached client asked for. */
	act(mirrored: Mirrored, input: MirrorIn, reply: (out: MirrorOut) => void): Promise<void>;
	/** The first line a client receives once attached. */
	hello(mirrored: Mirrored): MirrorOut;
};

const connections = new Map<string, Set<Socket>>();

/** Sends one line to every client attached to `id`. */
export function broadcast(id: string, out: MirrorOut): void {
	const sockets = connections.get(id);
	if (!sockets) return;
	const line = serialize(out);
	if (!line) return;
	for (const socket of sockets) write(socket, line);
}

/** Ends every connection to `id`. What the subagent's close does to its panes. */
export function hangUp(id: string): void {
	for (const socket of connections.get(id) ?? []) socket.end();
	connections.delete(id);
}

/** One client, from its first line to its last. */
export function serve(socket: Socket, mirrors: Mirrors): void {
	socket.setEncoding("utf8");
	let attached: Mirrored | undefined;
	let buffer = "";
	const reply = (out: MirrorOut) => {
		const line = serialize(out);
		if (line) write(socket, line);
	};

	socket.on("error", () => undefined);
	socket.on("close", () => {
		if (attached) connections.get(attached.id)?.delete(socket);
	});

	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			handle(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	});

	function handle(line: string) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			socket.end();
			return;
		}
		if (attached) {
			void mirrors.act(attached, parsed as MirrorIn, reply);
			return;
		}
		const id = (parsed as Attach | undefined)?.attach;
		const mirrored = typeof id === "string" ? mirrors.find(id) : undefined;
		if (!mirrored) {
			reply({ type: "error", message: `no subagent ${String(id)}` });
			socket.end();
			return;
		}
		attached = mirrored;
		let sockets = connections.get(mirrored.id);
		if (!sockets) connections.set(mirrored.id, (sockets = new Set()));
		sockets.add(socket);
		reply(mirrors.hello(mirrored));
		// A pane opened late still shows the whole turn: the transcript first,
		// then whatever happens next.
		for (const message of mirrored.session.messages) reply({ type: "message", message });
	}
}

function serialize(out: unknown): string | undefined {
	try {
		return `${JSON.stringify(out)}\n`;
	} catch {
		return undefined;
	}
}

function write(socket: Socket, line: string) {
	try {
		if (!socket.destroyed) socket.write(line);
	} catch {
		// a pane that went away is not the run's problem
	}
}
