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
import { formatSkillsForPrompt, SettingsManager, type ModelRuntime, type Skill } from "@earendil-works/pi-coding-agent";
import { lastTurn, resolvePattern, situate, StaticResourceLoader, streamed, subagentSettings, type AgentMessage } from "../src/session.ts";

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

describe("resolvePattern", () => {
	// pi's own resolver over a catalogue held in memory: the two methods it
	// reads, and none of `~/.pi`.
	const catalogue = (...models: Array<[provider: string, id: string]>) =>
		({
			getModels: () => models.map(([provider, id]) => ({ provider, id, name: id })),
			hasConfiguredAuth: () => false,
		}) as unknown as ModelRuntime;
	const runtime = catalogue(["ilaas", "qwen-3.6-35b-instruct"], ["ilaas", "gemma-4-31b"], ["local", "gemma-4-31b"]);
	const resolved = (pattern: string) => resolvePattern(pattern, runtime).model?.id;

	test("an exact, a partial and a suffixed pattern resolve to a model pi knows", () => {
		assert.equal(resolved("ilaas/qwen-3.6-35b-instruct"), "qwen-3.6-35b-instruct");
		assert.equal(resolved("ilaas/qwen-3.6"), "qwen-3.6-35b-instruct");
		assert.equal(resolved("qwen-3.6-35b-instruct:high"), "qwen-3.6-35b-instruct");
	});

	test("an id pi would only send as a custom one is refused, with pi's reason and where to declare it", () => {
		// pi accepts it with a warning, and the provider answers 404 on the
		// first turn of every subagent.
		const { model, refused } = resolvePattern("ilaas/nope-model", runtime);

		assert.equal(model, undefined);
		assert.match(refused ?? "", /^Model "nope-model" not found for provider "ilaas"\./);
		assert.match(refused ?? "", /models\.json/);
		assert.doesNotMatch(refused ?? "", /Using custom model id/, "it is not used, so it must not say so");
	});

	test("a pattern pi rejects is refused with pi's own words", () => {
		assert.match(resolvePattern("nope/model", runtime).refused ?? "", /^Model "nope\/model" not found\./);
		assert.match(resolvePattern("gemma-4-31b", runtime).refused ?? "", /ambiguous across providers: ilaas\/gemma-4-31b, local\/gemma-4-31b/);
	});
});

describe("subagentSettings", () => {
	/** pi's own manager over the two files it reads, held in memory. */
	const layered = (global: object, project: object = {}) => {
		const files = { global: JSON.stringify(global), project: JSON.stringify(project) };
		return SettingsManager.fromStorage({ withLock: (scope, read) => void read(files[scope]) });
	};

	// A user's settings with every named exception set, and a preference
	// beside each one that must stay behind.
	const user = {
		defaultProvider: "ilaas",
		defaultModel: "qwen",
		defaultThinkingLevel: "low",
		modelThinkingLevels: { "ilaas/qwen": "high" },
		shellPath: "/opt/bash",
		httpIdleTimeoutMs: 900_000,
		websocketConnectTimeoutMs: 30_000,
		retry: { enabled: false, maxRetries: 9, provider: { timeoutMs: 600_000, maxRetries: 4 } },
		enableInstallTelemetry: false,
		cacheWarming: "idle",
		shellCommandPrefix: "source ~/.aliases",
		compaction: { reserveTokens: 6000 },
		transport: "websocket",
	};

	test("takes the named exceptions, turns warming off, and leaves every preference behind", () => {
		assert.deepEqual(subagentSettings(layered(user)), {
			cacheWarming: "off",
			defaultProvider: "ilaas",
			defaultModel: "qwen",
			defaultThinkingLevel: "low",
			modelThinkingLevels: { "ilaas/qwen": "high" },
			shellPath: "/opt/bash",
			httpIdleTimeoutMs: 900_000,
			websocketConnectTimeoutMs: 30_000,
			retry: { provider: { timeoutMs: 600_000 } },
			enableInstallTelemetry: false,
		});
	});

	test("a user who set nothing gives a subagent pi's defaults, with warming off", () => {
		assert.deepEqual(subagentSettings(layered({})), { cacheWarming: "off" });
	});

	test("a repository chooses the model, never the shell, a timeout or the telemetry consent", () => {
		// A cloned repository's `.pi/settings.json` naming a binary is enough
		// for every subagent's bash tool to run it.
		const project = {
			defaultModel: "gemma",
			modelThinkingLevels: { "ilaas/gemma": "low" },
			shellPath: "/repo/evil.sh",
			httpIdleTimeoutMs: 1,
			websocketConnectTimeoutMs: 1,
			retry: { provider: { timeoutMs: 1 } },
			enableInstallTelemetry: true,
		};
		const seeded = subagentSettings(layered(user, project));

		assert.equal(seeded.defaultModel, "gemma");
		assert.deepEqual(seeded.modelThinkingLevels, { "ilaas/qwen": "high", "ilaas/gemma": "low" });
		assert.equal(seeded.shellPath, "/opt/bash");
		assert.equal(seeded.httpIdleTimeoutMs, 900_000);
		assert.equal(seeded.websocketConnectTimeoutMs, 30_000);
		assert.deepEqual(seeded.retry, { provider: { timeoutMs: 600_000 } });
		assert.equal(seeded.enableInstallTelemetry, false);
		assert.equal(subagentSettings(layered({}, project)).shellPath, undefined);
	});

	test("pi reads the seed back as the subagent's settings", () => {
		const settings = SettingsManager.inMemory(subagentSettings(layered(user)));

		assert.equal(settings.getCacheWarmingMode(), "off");
		assert.equal(settings.getDefaultModel(), "qwen");
		assert.equal(settings.getModelThinkingLevel("ilaas", "qwen"), "high");
		assert.equal(settings.getShellPath(), "/opt/bash");
		assert.equal(settings.getHttpIdleTimeoutMs(), 900_000);
		assert.equal(settings.getProviderRetrySettings().timeoutMs, 600_000);
		assert.equal(settings.getEnableInstallTelemetry(), false);
		assert.equal(settings.getShellCommandPrefix(), undefined);
		assert.equal(settings.getRetrySettings().maxRetries, SettingsManager.inMemory().getRetrySettings().maxRetries);
		assert.deepEqual(settings.getCompactionSettings(), SettingsManager.inMemory().getCompactionSettings());
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
