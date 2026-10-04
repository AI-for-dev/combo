/**
 * `sessionPort()`, the adapter from pi's session to a turn, on a pi-shaped
 * double: cumulative counters, a transcript a compaction rebuilds shorter, and
 * an `abort()` that really cuts the turn. Every pi trap a turn runs into is
 * held here, so the tests above the port can script turns as they come back.
 */

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, test } from "node:test";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { sessionPort, type AgentMessage, type Streamed, type Turn } from "../src/session.ts";
import { fakePiSession, type FakePiSession, type PiTurn } from "./fixtures/pi-session.ts";

/** One turn of `pi` through the adapter, with what it streamed. */
async function turnOf(pi: FakePiSession, signal = new AbortController().signal): Promise<Turn & { streamed: Streamed[] }> {
	const streamed: Streamed[] = [];
	const turn = await sessionPort(pi).ask("go", { signal, onStreamed: (event) => streamed.push(event) });
	return { ...turn, streamed };
}

/** The turns of one session, one after the other. */
async function turnsOf(turns: PiTurn[]): Promise<Turn[]> {
	const port = sessionPort(fakePiSession(turns));
	const done: Turn[] = [];
	for (const _ of turns) done.push(await port.ask("go", { signal: new AbortController().signal }));
	return done;
}

describe("sessionPort", () => {
	test("a turn costs what pi's cumulative counters gained during it, not the session's total", async () => {
		const [first, second] = await turnsOf([
			{ text: "one", tokens: { input: 100, output: 20 }, cost: 0.01 },
			{ text: "two", tokens: { input: 60, output: 10 }, cost: 0.02, contextTokens: 900 },
		]);

		assert.deepEqual([first?.usage.input, first?.usage.output], [100, 20]);
		assert.deepEqual([second?.usage.input, second?.usage.output, second?.usage.contextTokens], [60, 10, 900], "the raw total would read 160 here");
		assert.ok(Math.abs((second?.usage.cost ?? 0) - 0.02) < 1e-9);
		assert.deepEqual([second?.usage.wallMs, second?.usage.busyMs, second?.usage.turns], [0, 0, 0], "time is the caller's");
	});

	test("a turn's tool calls are what pi's count gained during it", async () => {
		const [first, second] = await turnsOf([{ text: "one", tools: [{ name: "grep" }, { name: "read" }] }, { text: "two" }]);
		assert.deepEqual([first?.usage.toolCalls, second?.usage.toolCalls], [2, 0], "the second turn called none, whatever the first did");
	});

	test("a field pi leaves out is 0, counters going backwards are 0, and an unknown context level is none", async () => {
		const pi = fakePiSession([{ text: "done" }]);
		const stats = (input: number, context: number | null) =>
			({ tokens: { input, output: undefined, cacheRead: 7, cacheWrite: 0, total: 0 }, cost: 0, contextUsage: { tokens: context, contextWindow: 200_000, percent: null } }) as unknown as SessionStats;
		const readings = [stats(5_000, 4_000), stats(800, null)];
		pi.getSessionStats = () => readings.shift() as SessionStats;

		const { usage } = await turnOf(pi);

		assert.deepEqual([usage.input, usage.output, usage.cacheRead, usage.contextTokens], [0, 0, 0, undefined]);
	});

	test("counters that throw cost nothing rather than the turn", async () => {
		const pi = fakePiSession([{ text: "done" }]);
		pi.getSessionStats = () => {
			throw new Error("no stats");
		};

		const turn = await turnOf(pi);

		assert.deepEqual([turn.text, turn.error, turn.usage.input], ["done", undefined, 0]);
	});

	test("a prompt that throws comes back as an error, with the tokens it already spent", async () => {
		const turn = await turnOf(fakePiSession([{ tokens: { input: 12_000 }, cost: 0.4, throws: "provider exploded" }]));

		assert.equal(turn.error, "provider exploded");
		assert.equal(turn.usage.input, 12_000, "a turn that died after 12k tokens still spent them");
	});

	test("a failing stopReason is an error without a throw, the output limit included, with or without text", async () => {
		const turns = await turnsOf([{ text: "partial", stopReason: "error" }, { stopReason: "length" }, { text: "half an answ", stopReason: "length" }]);

		assert.deepEqual(
			turns.map((turn) => [turn.text, turn.error]),
			[
				["partial", "boom"],
				["", "the answer reached the output limit"],
				["half an answ", "the answer reached the output limit"],
			],
		);
	});

	test("a turn that compacts mid-run still reads its own answer, and only its own messages", async () => {
		// pi rebuilds `messages` when it compacts, shorter than where the turn began.
		const [, , third] = await turnsOf([{ text: "one" }, { text: "two" }, { text: "three", compacts: true }]);

		assert.equal(third?.text, "three", "an empty answer read as a success is the bug");
		assert.deepEqual(
			third?.messages.map((m) => (m as { role: string }).role),
			["user", "assistant"],
			"the summary pi wrote is not something this turn said",
		);
	});

	test("the signal aborts pi's turn, and leaves no listener behind", async () => {
		const pi = fakePiSession([{ delayMs: 5_000, text: "never finished" }, { text: "next" }]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);

		const startedAt = performance.now();
		const cut = await turnOf(pi, controller.signal);

		assert.equal(pi.aborted, 1);
		assert.equal(cut.error, "aborted");
		assert.ok(performance.now() - startedAt < 1_000, "the turn was cut short, not waited out");

		const shared = new AbortController();
		await turnOf(pi, shared.signal);
		assert.equal(getEventListeners(shared.signal, "abort").length, 0);
	});

	test("a signal that fires while pi waits to retry fails the turn", async () => {
		// pi drops the failed attempt before it waits, so the cut turn resolves
		// on the last good message: a tool call, with no text and no error.
		const pi = fakePiSession([{ delayMs: 5_000 }]);
		const prompt = pi.prompt.bind(pi);
		pi.prompt = async (text) => {
			await prompt(text);
			pi.messages.pop();
			pi.messages.push({ role: "assistant", content: [], stopReason: "toolUse" } as unknown as AgentMessage);
		};
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);

		const turn = await turnOf(pi, controller.signal);

		assert.equal(turn.error, "aborted", "a turn with no answer is not an empty answer");
	});

	test("streams the answer and the tool calls, read, a tool pi did not name as ?", async () => {
		const turn = await turnOf(fakePiSession([{ text: "ok", tools: [{ name: "grep", args: { pattern: "x" } }, { name: "", args: 1 }] }]));

		assert.deepEqual(turn.streamed, [
			{ type: "tool", name: "grep", args: { pattern: "x" } },
			{ type: "tool", name: "?", args: 1 },
			{ type: "text", delta: "ok" },
		]);
	});

	test("a steer is queued only while a turn is in flight, and arrives in that turn", async () => {
		const pi = fakePiSession([{ text: "long", delayMs: 30 }]);
		const port = sessionPort(pi);

		assert.equal(await port.steer("too early"), "idle");
		const asked = port.ask("go", { signal: new AbortController().signal });
		assert.equal(await port.steer("look at test/ first"), "queued");
		const turn = await asked;

		assert.deepEqual(pi.steers, ["look at test/ first"], "an idle steer would answer the next task in its place");
		assert.ok(turn.messages.some((m) => (m as { content: unknown }).content === "look at test/ first"));
	});

	test("names the model pi resolved, and nothing when it resolved none", () => {
		const pi = fakePiSession();
		assert.equal(sessionPort(pi).model, undefined);
		assert.equal(sessionPort(Object.assign(pi, { model: { provider: "ilaas", id: "qwen" } })).model, "ilaas/qwen");
	});
});
