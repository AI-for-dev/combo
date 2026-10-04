/**
 * The whole pi API lives here, and nowhere else.
 *
 * The rest of the library only talks to {@link SessionPort}, a tiny subset of
 * `AgentSession`. Two consequences: when pi moves, only this file moves; and
 * tests inject a fake session with no network, no disk and no `~/.pi`.
 *
 * combo is written against pi 1.0 and later.
 */

import {
	createAgentSession,
	createExtensionRuntime,
	defineTool as piDefineTool,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	type AgentSession,
	type ContextUsage,
	type ResourceLoader,
	type SessionStats,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agent.ts";
import { answerInTheirLanguage } from "./language.ts";
import { resolveSkills, type Skill } from "./skills.ts";

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
 * What the library consumes from a pi session - nothing more.
 *
 * `AgentSession` satisfies this type structurally: no adapter to write, and a
 * fake session fits in fifty lines.
 */
export type SessionPort = {
	/** One turn. Returns when the model stops asking for tools; see `timeoutMs`. */
	prompt(text: string): Promise<void>;
	/** Every event of the turn. Returns the unsubscribe function. */
	subscribe(listener: (event: SessionEvent) => void): () => void;
	/** **Cumulative** over the session: a turn's usage is the difference of two snapshots. */
	getSessionStats(): SessionStats;
	/** How full the context is - what a persistent subagent has to be watched on. */
	getContextUsage(): ContextUsage | undefined;
	/** Cuts the in-flight turn short. `prompt()` takes no signal, so this is the bridge. */
	abort(): Promise<void>;
	/**
	 * Queues a word for the turn in flight, delivered after the tool call the
	 * model is in. **Only while `isStreaming`**: measured, a steer queued on an
	 * idle session is delivered with the next `prompt()` and answered in place
	 * of it, which silently changes what a workflow reads back from its own
	 * task. The mirror is the one caller, and it checks first. What pi resolves
	 * with, `"handled"` or `"queued"`, does not tell an idle session from a busy
	 * one, so it is not read.
	 */
	steer(text: string): Promise<unknown>;
	/** Whether a turn is in flight - the one moment a steer is safe. */
	readonly isStreaming: boolean;
	/** Releases the session. An undisposed session leaks; measurements come first. */
	dispose(): void;
	/**
	 * Writes the session as a readable HTML page. **Before `dispose()`.**
	 *
	 * Optional because it is not always available: pi refuses to export an
	 * in-memory session ("Cannot export in-memory session to HTML"), which is
	 * exactly what a subagent gets unless it was spawned with a `sessionDir`.
	 */
	exportToHtml?(outputPath?: string): Promise<string>;
	/** Writes the current branch as replayable JSONL. **Before `dispose()`.** */
	exportToJsonl?(outputPath?: string): string;
	/**
	 * What the model is shown next. It grows with every turn, until pi compacts:
	 * then it is rebuilt shorter, mid-run included, so a position read before a
	 * turn means nothing after it. A turn's own messages come from {@link ended}.
	 */
	readonly messages: AgentMessage[];
	/**
	 * The model actually in use, once pi has resolved it.
	 *
	 * Read, never set: an agent declares a *pattern* (`"anthropic/claude-sonnet-5"`,
	 * or nothing at all), and only the session knows what that became.
	 */
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

/** `provider/id`, or `undefined` when pi has not resolved a model. */
export function modelLabel(session: SessionPort): string | undefined {
	const model = session.model;
	if (!model?.id) return undefined;
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/**
 * The session events we listen to.
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
 * the port, and that member is what stops `event.type === …` from narrowing.
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
 * is what makes it reproducible.
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
	});

	return session;
};

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

	const model = resolvePattern(pattern, modelRuntime);
	if (!model) {
		throw new Error(`No model found for agent "${agent.name}": "${pattern}"`);
	}
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
	if (!resolvePattern(pattern, await ModelRuntime.create())) {
		throw new Error(`No model found for "${pattern}"`);
	}
}

/**
 * One pattern against pi's model catalogue.
 *
 * `resolveCliModel` takes `"anthropic/claude-sonnet-5"` as well as a partial
 * match, and splits off the provider itself: only when the prefix names a known
 * provider, so a model id that holds a slash of its own still resolves.
 */
function resolvePattern(pattern: string, modelRuntime: ModelRuntime) {
	return resolveCliModel({ cliModel: pattern, modelRuntime }).model;
}
