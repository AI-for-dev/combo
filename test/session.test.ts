/**
 * What `src/session.ts` reads of pi, held against the shapes pi gives it.
 *
 * Everything else injects a `SessionPort` and never touches pi's real module,
 * so a fake that drifts from pi would go unnoticed there: the loader, the
 * prompt and the readers of a transcript and of an event are checked here,
 * against pi's own types and helpers.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { lastTurn, situate, StaticResourceLoader, streamed, type AgentMessage } from "../src/session.ts";

/** A message in the shape pi keeps them, which is the shape under test here. */
const message = (fields: Record<string, unknown>) => fields as unknown as AgentMessage;
const assistant = (text: string, stopReason = "stop", errorMessage?: string) =>
	message({ role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage });

describe("StaticResourceLoader", () => {
	const skill: Skill = {
		name: "diffing",
		description: "Reads a diff",
		filePath: "/repo/agents/scout/skills/diffing/SKILL.md",
		baseDir: "/repo/agents/scout/skills/diffing",
		sourceInfo: { path: "/repo", source: "agent", scope: "project", origin: "top-level" },
		disableModelInvocation: false,
	};

	test("hands pi a skill in the shape pi advertises", () => {
		// pi's own formatter, not ours: the one thing a fake cannot check is
		// that what we build is what pi reads.
		const loader = new StaticResourceLoader("You scout.", [skill]);
		const advertised = formatSkillsForPrompt(loader.getSkills().skills);

		assert.match(advertised, /<name>diffing<\/name>/);
		assert.match(advertised, /<location>.*diffing\/SKILL\.md<\/location>/);
	});

	test("discovers nothing on its own, skills included", () => {
		const loader = new StaticResourceLoader("You scout.");

		assert.deepEqual(loader.getSkills().skills, []);
		assert.deepEqual(loader.getExtensions().extensions, []);
		assert.deepEqual(loader.getPrompts().prompts, []);
		assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
	});
});

describe("lastTurn", () => {
	test("the text of the last assistant message, its parts joined, whatever came after it", () => {
		const said = lastTurn([
			assistant("earlier"),
			message({ role: "assistant", content: [{ type: "text", text: " two " }, { type: "toolCall", id: "x" }, { type: "text", text: "parts" }], stopReason: "stop" }),
			message({ role: "user", content: "and then?" }),
		]);
		assert.deepEqual(said, { text: "two parts" });
	});

	test("a failing stopReason is an error, with pi's message or a word of our own", () => {
		assert.deepEqual(lastTurn([assistant("partial", "error", "402 from the provider")]), { text: "partial", error: "402 from the provider" });
		assert.deepEqual(lastTurn([assistant("partial", "error")]), { text: "partial", error: "model error" });
		assert.deepEqual(lastTurn([assistant("", "aborted")]), { text: "", error: "aborted" });
		assert.deepEqual(lastTurn([assistant("half", "length")]), { text: "half", error: "the answer reached the output limit" });
	});

	test("no assistant message is an empty answer, not a throw", () => {
		assert.deepEqual(lastTurn([]), { text: "" });
		assert.deepEqual(lastTurn([message({ role: "user", content: "hello" })]), { text: "" });
	});
});

describe("streamed", () => {
	test("a text delta and a tool call are read; anything else is nothing to a listener", () => {
		assert.deepEqual(streamed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }), { type: "text", delta: "hi" });
		assert.equal(streamed({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hm" } }), undefined);
		assert.deepEqual(streamed({ type: "tool_execution_start", toolName: "read", args: { path: "x" } }), { type: "tool", name: "read", args: { path: "x" } });
		assert.equal(streamed({ type: "turn_end" }), undefined);
	});

	test("a call that came back an error is read with pi's first words and its id; one that did not is nothing", () => {
		const end = { type: "tool_execution_end" as const, toolCallId: "c1", toolName: "write", result: { content: [{ type: "text", text: "Tool write not found" }] } };
		assert.deepEqual(streamed({ ...end, isError: true }), { type: "tool_error", name: "write", error: "Tool write not found", call: "c1" });
		assert.equal(streamed({ ...end, isError: false }), undefined);
		assert.deepEqual(streamed({ type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: {} }), { type: "tool", name: "write", args: {}, call: "c1" });
	});

	test("a tool pi could not name reads as ?, because its name arrives empty rather than absent", () => {
		assert.deepEqual(streamed({ type: "tool_execution_start", toolName: "", args: 1 }), { type: "tool", name: "?", args: 1 });
	});
});

describe("situate", () => {
	test("tells the subagent where it is, which nothing else does", () => {
		const prompt = situate("You locate code.", "/repo/app");

		assert.match(prompt, /^You locate code\./, "the agent's own prompt comes first, untouched");
		assert.match(prompt, /`\/repo\/app`/);
		assert.match(prompt, /relative paths/);
	});

	test("it is appended, never substituted for the definition", () => {
		// The failure it exists for: a scout invented `/Users/loic/gouarin/…`,
		// got "no such path" and gave up without trying a relative one. A prompt
		// that silently replaced the agent's own would trade one bug for a worse
		// one.
		assert.ok(situate("BODY", "/x").startsWith("BODY\n\n"));
	});
});
