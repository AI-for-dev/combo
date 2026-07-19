/**
 * The whole pi API lives here, and nowhere else.
 *
 * The rest of the library only talks to {@link SessionPort}, a tiny subset of
 * `AgentSession`. Two consequences: when pi moves, only this file moves; and
 * tests inject a fake session with no network, no disk and no `~/.pi`.
 */

import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	type AgentSession,
	type ContextUsage,
	type ResourceLoader,
	type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agent.ts";

/** Alias to pi's message type, without depending on a transitive package. */
export type AgentMessage = AgentSession["messages"][number];

/**
 * What the library consumes from a pi session - nothing more.
 *
 * `AgentSession` satisfies this type structurally: no adapter to write, and a
 * fake session fits in fifty lines.
 */
export type SessionPort = {
	prompt(text: string): Promise<void>;
	subscribe(listener: (event: SessionEvent) => void): () => void;
	getSessionStats(): SessionStats;
	getContextUsage(): ContextUsage | undefined;
	abort(): Promise<void>;
	dispose(): void;
	readonly messages: AgentMessage[];
};

/**
 * The session events we listen to.
 *
 * Deliberately loose on `type`: pi emits many more, and we ignore them. This
 * type describes what we know how to read, not what pi can produce.
 */
export type SessionEvent =
	| { type: "message_update"; assistantMessageEvent: { type: string; delta?: string } }
	| { type: "tool_execution_start"; toolName: string; args: unknown }
	| { type: "turn_end" }
	| { type: string };

/** Tools of an exploration agent: read, never write. This is the default. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Session creation settings, passed through by `spawn()`. */
export type CreateSessionOptions = {
	cwd?: string;
	/**
	 * Session directory dedicated to this run. Absent means an in-memory
	 * session: not exportable, and leaving no trace in `~/.pi`. That is the
	 * default, and it is intentional.
	 */
	sessionDir?: string;
};

/** Session factory. The injection point for tests. */
export type CreateSession = (agent: Agent, options: CreateSessionOptions) => Promise<SessionPort>;

/**
 * Creates a real, isolated pi session for an agent.
 *
 * The system prompt goes through a {@link StaticResourceLoader}: the subagent
 * inherits neither the user's extensions, nor their skills, nor their context
 * files. It only sees what its own definition gives it - which is what makes
 * it reproducible.
 */
export const createDefaultSession: CreateSession = async (agent, options) => {
	const cwd = options.cwd ?? process.cwd();
	const modelRuntime = await ModelRuntime.create();

	const { session } = await createAgentSession({
		cwd,
		modelRuntime,
		model: await resolveModel(agent, modelRuntime),
		tools: agent.tools ?? [...READ_ONLY_TOOLS],
		resourceLoader: new StaticResourceLoader(agent.systemPrompt),
		sessionManager: options.sessionDir ? SessionManager.create(cwd, options.sessionDir) : SessionManager.inMemory(cwd),
	});

	return session;
};

/**
 * A `ResourceLoader` that loads nothing: it returns the agent's system prompt,
 * and empty lists for everything else.
 *
 * `DefaultResourceLoader` would re-read the disk on every spawn, load the
 * user's extensions and trigger the project trust logic. For a subagent that
 * is non-deterministic context nobody asked for.
 */
export class StaticResourceLoader implements ResourceLoader {
	// Not a parameter property: Node erases types, it does not compile them.
	readonly #systemPrompt: string;

	constructor(systemPrompt: string) {
		this.#systemPrompt = systemPrompt;
	}

	// `LoadExtensionsResult` requires a runtime, even an empty one.
	getExtensions() {
		return { extensions: [], errors: [], runtime: createExtensionRuntime() };
	}
	getSkills() {
		return { skills: [], diagnostics: [] };
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
	getAppendSystemPrompt() {
		return [];
	}
	extendResources() {}
	async reload() {}
}

/**
 * Resolves `agent.model` into a pi model.
 *
 * `resolveCliModel` accepts `"anthropic/claude-sonnet-5"` as well as partial
 * matches. A pattern that resolves to nothing throws: better to fail at spawn
 * than to run a whole workflow on the wrong model.
 */
async function resolveModel(agent: Agent, modelRuntime: ModelRuntime) {
	if (!agent.model) return undefined;

	const [provider, ...rest] = agent.model.split("/");
	const hasProvider = rest.length > 0;
	const resolved = resolveCliModel({
		cliProvider: hasProvider ? provider : undefined,
		cliModel: hasProvider ? rest.join("/") : agent.model,
		modelRuntime,
	});

	if (!resolved.model) {
		throw new Error(`No model found for agent "${agent.name}": "${agent.model}"`);
	}
	return resolved.model;
}
