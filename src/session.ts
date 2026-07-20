/**
 * The whole pi API lives here, and nowhere else.
 *
 * The rest of the library only talks to {@link SessionPort}, a tiny subset of
 * `AgentSession`. Two consequences: when pi moves, only this file moves; and
 * tests inject a fake session with no network, no disk and no `~/.pi`.
 *
 * That second promise is why this file also absorbs pi's version churn - see
 * {@link buildModelOptions}. **Which pi matters is the one the code runs
 * inside**, not the one in `node_modules`: an extension is loaded into pi's own
 * process, so it resolves pi's own copy of the package. Homebrew ships 0.80.6
 * and npm ships 0.80.10, and those two do not agree on how models are built.
 */

import {
	createAgentSession,
	createExtensionRuntime,
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
	/** The transcript so far. It **grows** with every turn. */
	readonly messages: AgentMessage[];
	/**
	 * The model actually in use, once pi has resolved it.
	 *
	 * Read, never set: an agent declares a *pattern* (`"anthropic/claude-sonnet-5"`,
	 * or nothing at all), and only the session knows what that became.
	 */
	readonly model?: { provider?: string; id?: string };
};

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
	| { type: "tool_execution_start"; toolName: string; args: unknown }
	| { type: "turn_end" }
	| { type: string };

/** Tools of an exploration agent: read, never write. This is the default. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

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

	const { session } = await createAgentSession({
		cwd,
		...(await buildModelOptions(agent)),
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

/** The model-related options of `createAgentSession`, for whichever pi we found. */
type ModelOptions = Record<string, unknown>;

/**
 * Builds the model wiring, for either pi generation.
 *
 * pi renamed this surface between two *patch* releases: up to 0.80.6 it is
 * `AuthStorage` + `ModelRegistry`, from 0.80.7 it is a single `ModelRuntime`.
 * Homebrew still ships 0.80.6 while npm is on 0.80.10, so both are live, and an
 * extension gets whichever version of pi it was loaded into - our own
 * `node_modules` has no say in it.
 *
 * Detection is by presence, not by version string: a version number can be
 * patched, a missing export cannot be faked.
 */
async function buildModelOptions(agent: Agent): Promise<ModelOptions> {
	const pi = (await import("@earendil-works/pi-coding-agent")) as unknown as PiModule;
	const registry = await buildRegistry(pi);
	return { ...registry, model: resolveModel(agent, registry) };
}

/** The two shapes of pi's model API we know how to build. */
export type PiModule = {
	ModelRuntime?: { create(): Promise<unknown> };
	AuthStorage?: { create(): unknown };
	ModelRegistry?: { create(authStorage: unknown): unknown };
};

/**
 * Picks the model API this pi actually exposes.
 *
 * Detection is by **presence of the export**, never by version string: a
 * version number can be patched or mis-set, a missing export cannot be faked.
 * Exported so the choice is testable - it is the one thing our fake-session
 * tests structurally cannot reach, and it is exactly where a real bug hid.
 */
export async function buildRegistry(pi: PiModule): Promise<Record<string, unknown>> {
	// 0.80.7 and later.
	if (typeof pi.ModelRuntime?.create === "function") {
		return { modelRuntime: await pi.ModelRuntime.create() };
	}
	// 0.80.6 and earlier.
	if (typeof pi.AuthStorage?.create === "function" && typeof pi.ModelRegistry?.create === "function") {
		const authStorage = pi.AuthStorage.create();
		return { authStorage, modelRegistry: pi.ModelRegistry.create(authStorage) };
	}
	throw new Error(
		"Unsupported pi version: neither ModelRuntime nor AuthStorage/ModelRegistry is exported. pi-subagent supports 0.80.x.",
	);
}

/**
 * Resolves `agent.model` into a pi model.
 *
 * `resolveCliModel` accepts `"anthropic/claude-sonnet-5"` as well as partial
 * matches, and takes whichever of the two registries this pi understands. A
 * pattern that resolves to nothing throws: better to fail at spawn than to run
 * a whole workflow on the wrong model.
 */
function resolveModel(agent: Agent, registry: Record<string, unknown>) {
	if (!agent.model) return undefined;

	const [provider, ...rest] = agent.model.split("/");
	const hasProvider = rest.length > 0;
	const resolved = (resolveCliModel as unknown as (options: Record<string, unknown>) => { model?: unknown })({
		cliProvider: hasProvider ? provider : undefined,
		cliModel: hasProvider ? rest.join("/") : agent.model,
		...registry,
	});

	if (!resolved.model) {
		throw new Error(`No model found for agent "${agent.name}": "${agent.model}"`);
	}
	return resolved.model;
}
