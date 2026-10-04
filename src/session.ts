/**
 * The whole pi API lives here, and nowhere else.
 *
 * The rest of the library only talks to {@link SessionPort}, one turn at a
 * time, and {@link sessionPort} is the adapter over pi's `AgentSession`. Two
 * consequences: when pi moves, only this file moves; and tests inject a fake
 * session with no network, no disk and no `~/.pi`.
 *
 * combo is written against pi 1.0 and later.
 */

import {
	createAgentSession,
	createExtensionRuntime,
	defineTool as piDefineTool,
	getAgentDir,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ResolveCliModelResult,
	type ResourceLoader,
	type SessionStats,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agent.ts";
import { answerInTheirLanguage } from "./language.ts";
import { resolveSkills, type Skill } from "./skills.ts";
import { deltaUsage, emptyUsage, type Usage } from "./usage.ts";

/** Alias to pi's message type, without depending on a transitive package. */
export type AgentMessage = AgentSession["messages"][number];

/** Alias to pi's tool type, so a tool combo writes is described here alone. */
export type { ToolDefinition };

/**
 * pi's own `defineTool`, so a tool is built here and nowhere else.
 *
 * Bound to a constant rather than re-exported, which keeps the generic
 * signature that infers a tool's parameter type from its schema. Passing a tool
 * through an array loses that inference without it.
 */
export const defineTool = piDefineTool;

/**
 * What combo needs of a session: one turn at a time, read for it.
 *
 * Shaped by combo's callers rather than by pi's `AgentSession`. A turn comes
 * back with its own messages, its answer, why it failed and what it cost, so
 * nothing outside this file subtracts counters, parses pi's events or bridges
 * a signal to an abort. {@link sessionPort} builds one over pi's session; a
 * test or a dry run writes its own.
 */
export type SessionPort = {
	/**
	 * `provider/id` as pi resolved it, absent when it could not say.
	 *
	 * Read, never set: an agent declares a *pattern* (`"anthropic/claude-sonnet-5"`,
	 * or nothing at all), and only the session knows what that became.
	 */
	readonly model?: string;
	/**
	 * Runs one turn, until the model stops asking for tools or the signal
	 * fires. Never rejects: a turn that throws, is cut short or ends on a
	 * failing `stopReason` comes back with `error` set, and with what it cost.
	 */
	ask(text: string, options: TurnControl): Promise<Turn>;
	/**
	 * Queues a word for the turn in flight, delivered after the tool call the
	 * model is in, or answers `"idle"` and queues nothing when no turn is in
	 * flight. Measured: a steer queued on an idle pi session is delivered with
	 * the next prompt and answered in place of it, which silently changes what
	 * a workflow reads back from its own task.
	 */
	steer(text: string): Promise<"queued" | "idle">;
	/**
	 * pi's own events, as pi emits them, for the whole life of the session.
	 * The mirror's: a pane draws them with pi's own components, so they are not
	 * read here. Returns the unsubscribe function.
	 */
	watch(listener: (event: SessionEvent) => void): () => void;
	/**
	 * What the model is shown next. It grows with every turn, until pi compacts:
	 * then it is rebuilt shorter, mid-run included, so a turn's own messages are
	 * {@link Turn.messages}, never a slice of this.
	 */
	transcript(): readonly AgentMessage[];
	/**
	 * Writes the session as a readable HTML page. **Before `close()`.**
	 *
	 * Optional because it is not always available: pi refuses to export an
	 * in-memory session ("Cannot export in-memory session to HTML"), which is
	 * exactly what a subagent gets unless it was spawned with a `sessionDir`.
	 */
	exportToHtml?(outputPath: string): Promise<string>;
	/** Writes the current branch as replayable JSONL. **Before `close()`.** */
	exportToJsonl?(outputPath: string): string;
	/** Releases the session. An unreleased session leaks; exports come first. */
	close(): void;
};

/** What governs one turn of a {@link SessionPort}. */
export type TurnControl = {
	/**
	 * Cuts the turn short. Not yet aborted when the turn starts: refusing a
	 * turn that was stopped before it began is the caller's call, since no
	 * request was made.
	 */
	signal: AbortSignal;
	/** Each event of the turn a listener has a use for, already read. */
	onStreamed?: (event: Streamed) => void;
};

/** One turn, as the session read it. */
export type Turn = TurnReading & {
	/** The messages the turn added, in order: the prompt, each answer, each tool result, a steer once delivered. */
	messages: AgentMessage[];
	/**
	 * What pi billed for the turn, the tool calls it counted and the context
	 * it left. Time is the caller's: `wallMs`, `busyMs` and `turns` are `0` here.
	 */
	usage: Usage;
};

/**
 * The part of pi's `AgentSession` that {@link sessionPort} reads.
 *
 * `AgentSession` satisfies it structurally, and so does a test's pi-shaped
 * double, which is how the adapter is tested without pi.
 */
export type PiSession = {
	/** One turn. Resolves when the model stops asking for tools, or once `abort()` cut it. */
	prompt(text: string): Promise<void>;
	/** Every event, the turn's and any other. Returns the unsubscribe function. */
	subscribe(listener: (event: SessionEvent) => void): () => void;
	/** **Cumulative** over the session, compactions and failed attempts included. */
	getSessionStats(): SessionStats;
	/** `prompt()` takes no signal, so this is the bridge. */
	abort(): Promise<void>;
	/** What pi resolves with, `"handled"` or `"queued"`, does not tell an idle session from a busy one, so it is not read. */
	steer(text: string): Promise<unknown>;
	/** Whether a turn is in flight - the one moment a steer is safe. */
	readonly isStreaming: boolean;
	/** Releases the session; stats and exports are read before it. */
	dispose(): void;
	/** pi's HTML export. It refuses an in-memory session. */
	exportToHtml?(outputPath?: string): Promise<string>;
	/** pi's JSONL export of the current branch. */
	exportToJsonl?(outputPath?: string): string;
	/** The transcript the model is shown next, rebuilt shorter by a compaction. */
	readonly messages: AgentMessage[];
	/** The model pi resolved, once it has. */
	readonly model?: { provider?: string; id?: string };
};

/**
 * What the library reads of the parent pi session, the one a run is launched
 * from: pi's `ctx.sessionManager` fits it as it is.
 *
 * The file's path alone is not enough. pi creates a session's file with its
 * first message, so a command typed first in a fresh pi runs in a
 * session whose file does not exist yet, and `--no-session` never writes one.
 * The header and the entries are in memory from the start, and the file is
 * those and nothing else, one JSON object per line.
 */
export type MainSession = Pick<SessionManager, "getSessionFile" | "getHeader" | "getEntries">;

/**
 * pi's session events, as far as we read them: the adapter here, and the
 * mirror's pane, which draws them with pi's own components.
 *
 * Deliberately loose on `type`: pi emits many more, and we ignore them. This
 * type describes what we know how to read, not what pi can produce.
 */
export type SessionEvent =
	| { type: "message_update"; assistantMessageEvent: { type: string; delta?: string } }
	| { type: "tool_execution_start"; toolCallId?: string; toolName: string; args: unknown }
	| { type: "tool_execution_end"; toolCallId?: string; toolName: string; result?: { content?: readonly { type: string; text?: string }[] }; isError?: boolean }
	| { type: "message_end"; message: AgentMessage }
	| { type: "turn_end" }
	| { type: string };

/**
 * What a streamed event means to a listener: a piece of the answer, a tool
 * being called, or a call that came back an error. `call` is pi's id for the
 * call, which tells two calls of one tool apart when they run together.
 */
export type Streamed =
	| { type: "text"; delta: string }
	| { type: "tool"; name: string; args: unknown; call?: string }
	| { type: "tool_error"; name: string; error: string; call?: string };

/**
 * Reads a streamed session event, or nothing when it is one a listener has
 * no use for.
 *
 * The casts are here because they cannot be anywhere else: the union above
 * keeps a `{ type: string }` member so that pi's own listener type satisfies
 * {@link PiSession}, and that member is what stops `event.type === …` from narrowing.
 * A call pi cannot name arrives with an **empty** name rather than none, so
 * `??` never fires and the name would read as nothing at all - `|| "?"`.
 */
export function streamed(event: SessionEvent): Streamed | undefined {
	if (event.type === "message_update") {
		const inner = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
		return inner?.type === "text_delta" && inner.delta ? { type: "text", delta: inner.delta } : undefined;
	}
	if (event.type === "tool_execution_start") {
		const call = event as { toolCallId?: string; toolName?: string; args?: unknown };
		return { type: "tool", name: call.toolName?.trim() || "?", args: call.args, ...(call.toolCallId && { call: call.toolCallId }) };
	}
	if (event.type === "tool_execution_end") {
		// A call pi refused, an unknown tool or arguments it could not take, ends
		// as an error without running; so does one that ran and failed. pi's own
		// words say which.
		const end = event as Extract<SessionEvent, { type: "tool_execution_end" }>;
		if (!end.isError) return undefined;
		const said = (end.result?.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
		const error = said.split("\n").find((line) => line.trim() !== "")?.trim() ?? "error";
		return { type: "tool_error", name: end.toolName?.trim() || "?", error, ...(end.toolCallId && { call: end.toolCallId }) };
	}
	return undefined;
}

/**
 * The message pi has just added to the transcript, or nothing for any other
 * event.
 *
 * Every message a turn adds ends with one: the prompt, each answer, each tool
 * result, a steer once it is delivered. The summary a compaction writes in
 * their place does not, so a turn read off these is what it said, whatever
 * `messages` was rebuilt into meanwhile.
 */
export function ended(event: SessionEvent): AgentMessage | undefined {
	return event.type === "message_end" ? (event as { message?: AgentMessage }).message : undefined;
}

/** What the last turn of a transcript said, and how it ended. */
export type TurnReading = {
	/** The text parts of the last assistant message, joined and trimmed. `""` when there is none. */
	text: string;
	/** Set when that message ended on a failing `stopReason` (`error`, `aborted`, `length`): a turn can fail without throwing. */
	error?: string;
};

/**
 * Reads the last assistant message of a transcript: its text, and whether the
 * turn it ended failed.
 *
 * pi's message shape - the role, the content parts, `stopReason`,
 * `errorMessage` - is read here and nowhere else. Three places used to know
 * it: two readers in `subagent.ts` and the fake session that had to reproduce
 * what they read, which is one more than the invariant names.
 */
export function lastTurn(messages: readonly AgentMessage[]): TurnReading {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
		if (message?.role !== "assistant") continue;
		const text = Array.isArray(message.content)
			? message.content
					.filter((part): part is { type: "text"; text: string } => (part as { type?: string })?.type === "text")
					.map((part) => part.text)
					.join("")
					.trim()
			: "";
		if (message.stopReason === "error") return { text, error: message.errorMessage ?? "model error" };
		if (message.stopReason === "aborted") return { text, error: "aborted" };
		// The provider's output limit cut the answer off, often in its thinking
		// with no text at all: what is there is not the answer, however long.
		if (message.stopReason === "length") return { text, error: "the answer reached the output limit" };
		return { text };
	}
	return { text: "" };
}

/**
 * A {@link SessionPort} over pi's session.
 *
 * A turn's usage is the difference of `getSessionStats()` around the prompt,
 * not the sum of the turn's own messages. Measured on pi 1.0.2, the two agree
 * on every turn, aborted ones included, but a compaction's summary request is
 * billed to the compaction entry and emits no message, and pi compacts inside
 * `prompt()`. Only the stats see everything pi billed.
 */
export function sessionPort(pi: PiSession): SessionPort {
	return {
		model: modelLabel(pi.model),

		async ask(text, { signal, onStreamed }) {
			const before = readUsage(pi);
			const messages: AgentMessage[] = [];
			const unsubscribe = pi.subscribe((event) => {
				const message = ended(event);
				if (message) messages.push(message);
				const seen = onStreamed && streamed(event);
				if (seen) onStreamed(seen);
			});
			// Removed in the `finally`: a signal shared across several turns would
			// otherwise accumulate listeners.
			const onAbort = () => void pi.abort();
			signal.addEventListener("abort", onAbort, { once: true });
			let error: string | undefined;
			try {
				await pi.prompt(text);
				// pi drops a failed request from the conversation before it waits
				// to retry it. Cut during that wait, the turn returns quietly and
				// ends on the last good message, so only the signal still says the
				// turn never finished.
				if (signal.aborted) error = "aborted";
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			} finally {
				signal.removeEventListener("abort", onAbort);
				unsubscribe();
			}
			// A turn can also fail without throwing: pi reports it through the
			// last assistant message.
			const said = lastTurn(messages);
			return { messages, text: said.text, error: error ?? said.error, usage: deltaUsage(before, readUsage(pi)) };
		},

		async steer(text) {
			if (!pi.isStreaming) return "idle";
			await pi.steer(text);
			return "queued";
		},

		watch: (listener) => pi.subscribe(listener),
		transcript: () => pi.messages,
		exportToHtml: pi.exportToHtml && ((outputPath) => pi.exportToHtml!(outputPath)),
		exportToJsonl: pi.exportToJsonl && ((outputPath) => pi.exportToJsonl!(outputPath)),
		close: () => pi.dispose(),
	};
}

/** `provider/id`, or `undefined` when pi has not resolved a model. */
function modelLabel(model: PiSession["model"]): string | undefined {
	if (!model?.id) return undefined;
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/**
 * The session's counters, never letting a broken provider bring a turn down.
 *
 * A field the provider does not report is `0`; nothing is estimated from
 * characters. `contextTokens` is a level, so a `null` from pi (unknown since
 * the last compaction) is no reading at all.
 */
function readUsage(pi: PiSession): Usage {
	try {
		const stats = pi.getSessionStats();
		return {
			...emptyUsage(),
			toolCalls: stats.toolCalls ?? 0,
			input: stats.tokens.input ?? 0,
			output: stats.tokens.output ?? 0,
			cacheRead: stats.tokens.cacheRead ?? 0,
			cacheWrite: stats.tokens.cacheWrite ?? 0,
			cost: stats.cost ?? 0,
			contextTokens: stats.contextUsage?.tokens ?? undefined,
		};
	} catch {
		return emptyUsage();
	}
}

/** Tools of an exploration agent: read, never write. This is the default. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** The tools an agent is spawned with: the ones it names, or {@link READ_ONLY_TOOLS}. */
export function toolsOf(agent: Agent): string[] {
	return agent.tools ?? [...READ_ONLY_TOOLS];
}

/** Session creation settings, passed through by `spawn()`. */
export type CreateSessionOptions = {
	/** Working directory of the session. Defaults to the process's own. */
	cwd?: string;
	/**
	 * Session directory dedicated to this run. Absent means an in-memory
	 * session: not exportable, and leaving no trace in `~/.pi`. That is the
	 * default, and it is intentional.
	 */
	sessionDir?: string;
	/**
	 * Model pattern for this session, already resolved against the precedence
	 * ladder by `spawn()` - see `SpawnOptions.model`. Absent means pi's own
	 * settings decide, which is the last resort, never a choice made here.
	 */
	model?: string;
	/**
	 * Tools combo itself defines, offered to this session.
	 *
	 * Offering is not granting: `tools` is an allowlist and it covers these too,
	 * so a tool the agent's `tools:` does not name is not enabled. That leaves
	 * the guarantee of {@link StaticResourceLoader} intact - a subagent still
	 * inherits nothing from the user's environment, and what it can do is
	 * readable in its own definition.
	 */
	customTools?: ToolDefinition[];
};

/** Session factory. The injection point for tests. */
export type CreateSession = (agent: Agent, options: CreateSessionOptions) => Promise<SessionPort>;

/**
 * Creates a real, isolated pi session for an agent.
 *
 * The system prompt goes through a {@link StaticResourceLoader}: the subagent
 * inherits neither the user's extensions, nor their context files, nor any
 * skill it did not name. It only sees what its own definition gives it - which
 * is what makes it reproducible. Its settings are held in memory and seeded by
 * {@link subagentSettings}, so pi's settings files reach it only through the
 * keys that function names, each from the layer it names.
 */
export const createDefaultSession: CreateSession = async (agent, options) => {
	const cwd = options.cwd ?? process.cwd();
	const tools = toolsOf(agent);
	const modelRuntime = await ModelRuntime.create();

	const { session } = await createAgentSession({
		cwd,
		modelRuntime,
		model: resolveModel(agent, modelRuntime, options.model),
		tools,
		customTools: options.customTools,
		// Its own prompt, then the two standing facts it cannot work without:
		// where it stands, and who it is answering.
		resourceLoader: new StaticResourceLoader(
			answerInTheirLanguage(situate(agent.systemPrompt, cwd)),
			resolveSkills(agent, cwd, tools),
		),
		sessionManager: options.sessionDir ? SessionManager.create(cwd, options.sessionDir) : SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(subagentSettings(SettingsManager.create(cwd, getAgentDir()))),
	});

	return sessionPort(session);
};

/** pi's settings, as `settings.json` writes them. */
type Settings = ReturnType<SettingsManager["getSettings"]>;

/**
 * The settings a subagent takes from pi's files, and the only ones, by the
 * layer each is read from.
 *
 * `merged` is the last step of the model ladder (invariant 5): global and
 * project merged, project winning, as pi reads them, because which model works
 * on a repository is the repository's call too. `global` holds facts about the
 * machine, or a consent: where bash is, how long a slow provider is given
 * before a request is cut, and whether the user turned pi's telemetry headers
 * off. A repository cannot know those, and taking them from its
 * `.pi/settings.json` would let a cloned repository pick the binary every
 * subagent's `bash` runs. Everything else is a preference (`shellCommandPrefix`,
 * compaction, retries, transport...) and stays at pi's default.
 */
const INHERITED_SETTINGS = {
	merged: ["defaultProvider", "defaultModel", "defaultThinkingLevel", "modelThinkingLevels"],
	global: ["shellPath", "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "retry.provider.timeoutMs", "enableInstallTelemetry"],
} as const;

/**
 * A subagent's settings, built from what `pi` read of the user's and the
 * repository's files: the keys of {@link INHERITED_SETTINGS}, each from its
 * layer, and cache warming off.
 *
 * Warming is off because a warm-up is a request pi sends on its own and counts
 * in `getSessionStats()`, so it would land in a turn's usage: while a subagent
 * waits on a long tool call, and, with `cacheWarming: "idle"`, between two
 * `ask()` calls of a persistent one. It is not seeded from the user's, because
 * whether a subagent warms is combo's decision.
 */
export function subagentSettings(pi: SettingsManager): Settings {
	const seeded: Record<string, unknown> = { cacheWarming: "off" };
	const layers = { merged: pi.getSettings(), global: pi.getGlobalSettings() };
	for (const layer of ["merged", "global"] as const) {
		for (const path of INHERITED_SETTINGS[layer]) {
			const keys = path.split(".");
			const value = keys.reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], layers[layer]);
			if (value === undefined) continue;
			const leaf = keys.pop() as string;
			let at = seeded;
			for (const key of keys) at = (at[key] ??= {}) as Record<string, unknown>;
			at[leaf] = value;
		}
	}
	return seeded as Settings;
}

/**
 * The agent's prompt, plus the one fact it cannot do its job without: where it is.
 *
 * A subagent inherits nothing from the user's environment, deliberately - but
 * its own working directory is not inherited context, it is the ground every
 * tool call stands on. Without it a model guesses, and a real run showed exactly
 * what that costs: a scout called `ls /Users/loic/gouarin/…` - the user's name
 * with a dot turned into a slash - got "no such path", and gave up without
 * trying a relative one. One branch of three, wasted on a fabricated path.
 */
export function situate(systemPrompt: string, cwd: string): string {
	return `${systemPrompt}\n\nYour working directory is \`${cwd}\`. Tool paths are resolved from it: use relative paths, and never invent an absolute one.`;
}

/**
 * A `ResourceLoader` that discovers nothing: it returns the agent's system
 * prompt, the skills it was handed, and empty lists for everything else.
 *
 * `DefaultResourceLoader` would re-read the disk on every spawn, load the
 * user's extensions and trigger the project trust logic. For a subagent that
 * is non-deterministic context nobody asked for. Skills are the one thing that
 * comes from outside the definition, and even then only by name: they are
 * resolved by `resolveSkills` before we get here, never found by this loader.
 */
export class StaticResourceLoader implements ResourceLoader {
	// Not a parameter property: Node erases types, it does not compile them.
	readonly #systemPrompt: string;
	readonly #skills: Skill[];

	constructor(systemPrompt: string, skills: Skill[] = []) {
		this.#systemPrompt = systemPrompt;
		this.#skills = skills;
	}

	// `LoadExtensionsResult` requires a runtime, even an empty one.
	getExtensions() {
		return { extensions: [], errors: [], runtime: createExtensionRuntime() };
	}
	getSkills() {
		return { skills: this.#skills, diagnostics: [] };
	}
	getPrompts() {
		return { prompts: [], diagnostics: [] };
	}
	getThemes() {
		return { themes: [], diagnostics: [] };
	}
	getAgentsFiles() {
		return { agentsFiles: [] };
	}
	getSystemPrompt() {
		return this.#systemPrompt;
	}
	// The prompt is built from the definition and held in memory, so there is no
	// file for pi to name when it reports where a system prompt came from.
	getSystemPromptSource() {
		return undefined;
	}
	getAppendSystemPrompt() {
		return [];
	}
	getAppendSystemPromptSources() {
		return [];
	}
	extendResources() {}
	async reload() {}
}

/**
 * Resolves a model pattern into a pi model, or `undefined` with no pattern.
 *
 * The pattern defaults to `agent.model`; a caller's override arrives already
 * chosen by `spawn()`. A pattern that resolves to nothing throws: better to
 * fail at spawn than to run a whole workflow on the wrong model.
 */
function resolveModel(agent: Agent, modelRuntime: ModelRuntime, pattern = agent.model) {
	if (!pattern) return undefined;

	const { model, refused } = resolvePattern(pattern, modelRuntime);
	if (refused !== undefined) throw new Error(`No model for agent "${agent.name}": ${refused}`);
	return model;
}

/**
 * Checks that a model pattern resolves in this pi, without opening a session.
 *
 * For whoever takes a `--model` argument: `/interview` asks the user for
 * minutes before the first spawn and `/build` runs unwatched, and a typo must
 * cost a second, not a conversation or a run found stopped. It reads the real
 * model catalogue, so a fake cannot stand in for it: only a real pi run proves
 * it end to end.
 */
export async function checkModel(pattern: string): Promise<void> {
	const { refused } = resolvePattern(pattern, await ModelRuntime.create());
	if (refused !== undefined) throw new Error(refused);
}

/** A model pi resolved, or why there is none. */
export type ResolvedPattern =
	| { model: NonNullable<ResolveCliModelResult["model"]>; refused?: undefined }
	| { model?: undefined; refused: string };

/**
 * One pattern against pi's model catalogue, refused unless it names a model pi
 * knows.
 *
 * `resolveCliModel` takes `"anthropic/claude-sonnet-5"` as well as a partial
 * match, and splits off the provider itself: only when the prefix names a known
 * provider, so a model id that holds a slash of its own still resolves.
 *
 * For a known provider and an id it does not list, pi builds a custom model
 * and says so in `warning`. That is the only warning it returns beside a model,
 * since it parses a `:thinking` suffix strictly here. The provider then answers
 * 404 on the first turn of every subagent, so the pattern is refused instead:
 * a typo must not start a run.
 */
export function resolvePattern(pattern: string, modelRuntime: ModelRuntime): ResolvedPattern {
	const { model, warning, error } = resolveCliModel({ cliModel: pattern, modelRuntime });
	if (!model) return { refused: error ?? `No model found for "${pattern}"` };
	if (warning) {
		const reason = warning.replace(/\s*Using custom model id\.$/, "");
		return { refused: `${reason} Add it to pi's models.json to run it.` };
	}
	return { model };
}
