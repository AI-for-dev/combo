import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createConnection, type Socket } from "node:net";
import { after, beforeEach, describe, test } from "node:test";
import { createEventBus, resetSubagentIds, type SubagentEvent } from "../src/events.ts";
import { mirrorSocket, registerMirror, REFUSED_IDLE } from "../src/mirror.ts";
import type { SessionEvent, SessionPort } from "../src/session.ts";
import { spawn } from "../src/subagent.ts";
import { fakeSession, type Turn } from "./fixtures/fake-session.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

const scout = testAgent("scout");

/** A line off the wire. Loose on purpose: the tests read it the way a client would. */
type Line = { type: string } & Record<string, any>;

/** A client of the mirror: what it received, and a way to wait for more. */
type Client = {
	lines: Line[];
	send(input: unknown): void;
	/** Resolves with the first line matching `pick`, already received or not. */
	next(pick: (line: Line) => boolean): Promise<Line>;
	ended: Promise<void>;
	socket: Socket;
};

const clients: Socket[] = [];
after(() => {
	for (const socket of clients) socket.destroy();
});

/**
 * Connects and attaches. Every test speaks the wire, not the functions.
 *
 * Resolves once the server has answered, with `attached` or `error`: before
 * that, the server has not filed the connection and a line sent to the
 * subagent would go out to nobody - which is exactly what a client has to
 * wait for too.
 */
function attach(id: string): Promise<Client> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(mirrorSocket());
		clients.push(socket);
		const lines: Line[] = [];
		const waiting: { pick: (line: Line) => boolean; resolve: (line: Line) => void }[] = [];
		let buffer = "";
		let end!: () => void;
		const ended = new Promise<void>((done) => (end = done));

		socket.setEncoding("utf8");
		socket.on("error", reject);
		socket.on("end", () => end());
		socket.on("close", () => end());
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (const raw of buffer.split("\n").slice(0, -1)) {
				const line = JSON.parse(raw) as Line;
				lines.push(line);
				for (const waiter of waiting.splice(0)) {
					if (waiter.pick(line)) waiter.resolve(line);
					else waiting.push(waiter);
				}
			}
			buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
		});
		const client: Client = {
			lines,
			socket,
			ended,
			send: (input) => socket.write(`${JSON.stringify(input)}\n`),
			next: (pick) =>
				new Promise((found) => {
					const seen = lines.find(pick);
					if (seen) found(seen);
					else waiting.push({ pick, resolve: found });
				}),
		};
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ attach: id })}\n`);
			void client.next((line) => line.type === "attached" || line.type === "error").then(() => resolve(client));
		});
	});
}

async function spawnWith(turns: Turn[], onEvent?: (event: SubagentEvent) => void) {
	const session = fakeSession(turns);
	const subagent = await spawn(scout, { createSession: async () => session, onEvent });
	return { subagent, session };
}

beforeEach(() => resetSubagentIds());

describe("mirror", () => {
	test("attaching replays the transcript, then streams the next turn as pi emits it", async () => {
		const { subagent } = await spawnWith([
			{ text: "first", tools: [{ name: "read", args: { path: "a.ts" } }] },
			{ text: "second", tools: [{ name: "grep" }] },
		]);
		try {
			await subagent.ask("one");
			const client = await attach(subagent.id);
			const hello = await client.next((line) => line.type === "attached");
			assert.deepEqual(
				{ id: hello.id, agent: hello.agent, cwd: hello.cwd },
				{ id: "scout#1", agent: "scout", cwd: process.cwd() },
			);
			assert.match(String(hello.pi), /pi-coding-agent/, "the client draws with the pi that produced the events");

			// The turn already done arrives as messages, in order.
			await client.next((line) => line.type === "message" && (line.message as { role: string }).role === "assistant");
			const replayed = client.lines.filter((line) => line.type === "message").map((line) => (line.message as { role: string }).role);
			assert.deepEqual(replayed, ["user", "assistant"]);

			await subagent.ask("two");
			await client.next((line) => line.type === "status" && line.status === "idle" && client.lines.some((l) => l.type === "turn_end"));
			const live = client.lines.slice(client.lines.indexOf(client.lines.find((l) => l.type === "status" && l.status === "working")!)).map((l) => l.type);
			assert.deepEqual(
				live,
				["status", "tool_execution_start", "message_update", "turn_end", "usage", "status"],
				"pi's own events, in the order they were emitted, with ours around them",
			);
		} finally {
			await subagent.close();
		}
	});

	test("a word typed while it works reaches the session, and the record", async () => {
		const seen: SubagentEvent[] = [];
		const { subagent, session } = await spawnWith([{ text: "long", delayMs: 300 }], (event) => seen.push(event));
		try {
			const client = await attach(subagent.id);
			const asked = subagent.ask("work");
			await client.next((line) => line.type === "status" && line.status === "working");
			client.send({ type: "steer", text: "look at test/ first" });
			await client.next((line) => line.type === "steer");
			const result = await asked;

			assert.deepEqual(session.steers, ["look at test/ first"]);
			assert.ok(
				seen.some((event) => event.type === "steer" && event.text === "look at test/ first"),
				"a person's word is on the run's stream",
			);
			assert.ok(result.messages.some((m) => (m as { content: unknown }).content === "look at test/ first"), "and in the turn the workflow reads back");
			assert.ok(!client.lines.some((line) => line.type === "refused"));
		} finally {
			await subagent.close();
		}
	});

	test("a word typed between tasks is refused, and nothing is queued", async () => {
		const seen: SubagentEvent[] = [];
		const { subagent, session } = await spawnWith([{ text: "done" }], (event) => seen.push(event));
		try {
			await subagent.ask("one");
			const client = await attach(subagent.id);
			client.send({ type: "steer", text: "also this" });
			const refused = await client.next((line) => line.type === "refused");

			assert.equal(refused.reason, REFUSED_IDLE);
			assert.deepEqual(session.steers, [], "measured: a steer queued while idle answers the next task in its place");
			assert.ok(!seen.some((event) => event.type === "steer"), "nothing happened, so nothing is recorded");
		} finally {
			await subagent.close();
		}
	});

	test("abort from the pane stops the subagent, like /stop", async () => {
		const { subagent } = await spawnWith([{ text: "never", delayMs: 5_000 }]);
		try {
			const client = await attach(subagent.id);
			const started = performance.now();
			const asked = subagent.ask("work");
			await client.next((line) => line.type === "status" && line.status === "working");
			client.send({ type: "abort" });
			const result = await asked;

			assert.equal(result.ok, false);
			assert.equal(result.error, "stopped");
			assert.ok(performance.now() - started < 2_000, "the turn was cut short, not waited out");
		} finally {
			await subagent.close();
		}
	});

	test("closing the subagent tells the client, then hangs up", async () => {
		const { subagent } = await spawnWith([{ text: "bye" }]);
		const client = await attach(subagent.id);
		await client.next((line) => line.type === "attached");
		await subagent.close();
		await client.next((line) => line.type === "close");
		await client.ended;
		assert.equal(client.lines.at(-1)?.type, "close");
	});

	test("an id nobody has is an error line, and the connection ends", async () => {
		const { subagent } = await spawnWith([]);
		try {
			const client = await attach("nobody#9");
			const error = await client.next((line) => line.type === "error");
			assert.match(String(error.message), /no subagent nobody#9/);
			await client.ended;
		} finally {
			await subagent.close();
		}
	});

	test("the socket goes with the last subagent", async () => {
		const { subagent } = await spawnWith([]);
		const socketPath = mirrorSocket();
		const client = await attach(subagent.id);
		await client.next((line) => line.type === "attached");
		await subagent.close();
		await client.ended;
		assert.ok(!fs.existsSync(socketPath), "a listening socket for nobody would keep the next run guessing");
	});

	test("partial messages are held back and never overtake what follows them", async () => {
		// A session emitting fifty partial messages in one tick, then a tool call:
		// the client wants the latest partial, once, and in order.
		const listeners = new Set<(event: SessionEvent) => void>();
		const emit = (event: SessionEvent) => {
			for (const listener of listeners) listener(event);
		};
		const session: SessionPort = {
			messages: [],
			isStreaming: false,
			async prompt() {
				for (let i = 1; i <= 50; i++) {
					emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: String(i) } });
				}
				emit({ type: "tool_execution_start", toolName: "read", args: {} });
				emit({ type: "turn_end" });
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			getSessionStats: () => ({ tokens: {}, cost: 0 }) as never,
			getContextUsage: () => undefined,
			async abort() {},
			async steer() {},
			dispose() {},
		};
		const bus = createEventBus();
		const unregister = registerMirror({ id: "burst#1", agent: "burst", cwd: "/", session, bus, stop() {} });
		try {
			const client = await attach("burst#1");
			await client.next((line) => line.type === "attached");
			await session.prompt("go");
			await client.next((line) => line.type === "turn_end");

			const types = client.lines.map((line) => line.type).filter((type) => type !== "attached");
			assert.deepEqual(types, ["message_update", "tool_execution_start", "turn_end"]);
			const update = client.lines.find((line) => line.type === "message_update");
			assert.equal(update?.assistantMessageEvent.delta, "50", "the latest partial is the one that goes out");
		} finally {
			unregister();
		}
	});
});
