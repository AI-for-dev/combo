import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { resetSubagentIds } from "../src/events.ts";
import type { AgentMessage } from "../src/session.ts";
import { spawn } from "../src/subagent.ts";
import { fakeSession } from "./fixtures/fake-session.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

beforeEach(() => resetSubagentIds());

/**
 * A session cut the way pi is cut while it waits to retry a failed request:
 * the failed attempt is already gone from its messages, so the turn resolves
 * on the last good one, a tool call with no text and no error.
 */
function cutWhileRetrying() {
	const session = fakeSession([{ delayMs: 5_000 }]);
	const prompt = session.prompt.bind(session);
	session.prompt = async (text) => {
		await prompt(text);
		session.messages.pop();
		session.messages.push({ role: "assistant", content: [], stopReason: "toolUse" } as unknown as AgentMessage);
	};
	return session;
}

test("a deadline that fires while pi waits to retry fails the turn", async () => {
	const session = cutWhileRetrying();
	const subagent = await spawn(testAgent("scout"), { createSession: async () => session });

	const result = await subagent.ask("a", { timeoutMs: 20 });

	assert.equal(result.ok, false, "a turn with no answer is not an empty answer");
	assert.equal(result.error, "timed out after 20ms");
	await subagent.close();
});

test("a stop that lands while pi waits to retry fails the turn", async () => {
	const session = cutWhileRetrying();
	const subagent = await spawn(testAgent("scout"), { createSession: async () => session });

	const pending = subagent.ask("a");
	setTimeout(() => subagent.stop(), 10);
	const result = await pending;

	assert.equal(result.ok, false);
	assert.equal(result.error, "stopped");
	await subagent.close();
});
