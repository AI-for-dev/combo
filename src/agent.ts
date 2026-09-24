/**
 * An agent is *content*: a system prompt, a model, a set of tools.
 * It is declared as Markdown + frontmatter, following the pi convention.
 *
 * This file knows nothing about sessions or workflows: it turns files into
 * data. Bringing an agent to life is `spawn()`'s job.
 */

import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENTS_DIR } from "./builtin.ts";
import { asBoolean, asCount, asList, asString, definitionDirs, readMarkdownDir, yamlError, type MarkdownFile } from "./markdown.ts";

/** Directory name under `~/.pi/agent/` and under `.pi/`. */
export const AGENTS_DIR = "agents";

/**
 * Lifetime of a subagent - the central choice of this library.
 *
 * - `"task"`: born and dies with each task. Minimal context, reproducible.
 * - `"workflow"`: lives for the duration of the workflow. Remembers iterations.
 * - `"session"`: lives as long as the pi session. Long memory, watch it.
 */
export type Lifetime = "task" | "workflow" | "session";

/** Every {@link Lifetime}, for whoever validates one - the tool's schema names them from here. */
export const LIFETIMES = ["task", "workflow", "session"] as const satisfies readonly Lifetime[];

/**
 * Where an agent definition came from.
 *
 * `"builtin"` is what this package ships. It is the lowest priority of the
 * three: a `"user"` definition of the same name replaces it, and a `"project"`
 * one replaces both.
 */
export type AgentSource = "user" | "project" | "builtin";

/** Where to look for definitions. Defaults to `"user"` - see {@link loadAgents}. */
export type AgentScope = "user" | "project" | "both";

/** An agent: the "who". Inert data, no state, no session. */
export type Agent = {
	/** Unique name, and how every caller refers to it. Mandatory in the file. */
	name: string;
	/**
	 * What this agent is for, in one line. Mandatory in the file.
	 *
	 * Not decoration: `route` and `orchestrate` hand this text to a model to
	 * decide who does the work, so a vague description produces vague routing
	 * that no parser can repair.
	 */
	description: string;
	/** Markdown body, used verbatim as the system prompt. */
	systemPrompt: string;
	/** Allowed tools. Absent means the read-only default is applied at spawn. */
	tools?: string[];
	/**
	 * Skills this agent may load, by name - an allowlist, exactly like `tools`.
	 *
	 * Absent means none: a subagent is offered no skill it did not ask for.
	 * `resolveSkills` in `src/skills.ts` says where a name is looked up.
	 */
	skills?: string[];
	/** Model pattern, e.g. `"anthropic/claude-sonnet-5"`. Absent means pi's default. */
	model?: string;
	/** Default lifetime, in a workflow as in `spawn`. An explicit call always wins. */
	lifetime?: Lifetime;
	/**
	 * How many subagents this agent runs at once when it delegates.
	 *
	 * Only meaningful for an agent whose `tools:` names `subagent`. It is the
	 * agent's own business rather than the caller's: how wide a split is worth
	 * making depends on how the agent was told to think about its task, which is
	 * what its definition says.
	 */
	concurrency?: number;
	/**
	 * Default for "give this agent its own herdr split". An explicit call wins.
	 *
	 * Declaring it here is often what you want: a scout is worth watching every
	 * time, whoever calls it.
	 */
	openInHerdr?: boolean;
	/** Where the definition was found - a repository's agents are loaded only on request. */
	source: AgentSource;
	/** File path, or a free label for an agent built in memory. */
	filePath: string;
};

/**
 * The lifetime a subagent of `agent` runs with: the one `asked` for, then the
 * agent's frontmatter, then `"task"`. Every place that spawns reads it here, so
 * a workflow and a direct `spawn` cannot disagree on what a definition asked.
 */
export function lifetimeOf(agent: Agent, asked?: Lifetime): Lifetime {
	return asked ?? agent.lifetime ?? "task";
}

/**
 * An agent file that is not an agent: kept by a catalogue that reports it,
 * where {@link loadAgents} drops it.
 */
export type BrokenAgent = {
	/** The name it would be asked for by: its `name:` when it has one, else its file name without `.md`. */
	name: string;
	filePath: string;
	source: AgentSource;
	/** Why it is not an agent, in one sentence. */
	error: string;
};

/**
 * Parses an agent definition.
 *
 * Returns `undefined` when the frontmatter is not valid YAML, or when `name` or
 * `description` is missing: this is pi's behaviour, a file that is not an agent
 * is ignored **silently**. Kept separate from {@link loadAgents} so it stays
 * testable without touching the disk.
 */
export function parseAgent(content: string, filePath: string, source: AgentSource): Agent | undefined {
	// Agents are discovered, not asked for: one bad file among the user's must
	// not take every other agent down with it, so a file that is not one is dropped.
	const agent = readAgentFile({ name: "", filePath, content }, source);
	return "error" in agent ? undefined : agent;
}

/**
 * Reads an agent file, and says why when it is not one: the YAML error, or the
 * keys it lacks. Where {@link parseAgent} drops a file in silence, this keeps
 * it, for a caller that validates before it runs and must not answer "unknown
 * agent" about a file sitting right there.
 */
export function readAgentFile(file: MarkdownFile, source: AgentSource): Agent | BrokenAgent {
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(file.content);
	} catch (cause) {
		return { name: file.name, filePath: file.filePath, source, error: `its frontmatter is not valid YAML: ${yamlError(cause)}` };
	}
	const agent = agentFrom(parsed.frontmatter, parsed.body, file.filePath, source);
	if (typeof agent !== "string") return agent;
	return { name: asString(parsed.frontmatter.name) ?? file.name, filePath: file.filePath, source, error: agent };
}

/** The agent a parsed file defines, or why it defines none. */
function agentFrom(frontmatter: Record<string, unknown>, body: string, filePath: string, source: AgentSource): Agent | string {
	const name = asString(frontmatter.name);
	const description = asString(frontmatter.description);
	if (!name || !description) {
		const missing = [!name && "`name:`", !description && "`description:`"].filter(Boolean).join(" and no ");
		return `it has no ${missing}, which an agent needs`;
	}

	const lifetime = asString(frontmatter.lifetime);
	return {
		name,
		description,
		systemPrompt: body.trim(),
		tools: asList(frontmatter.tools),
		skills: asList(frontmatter.skills),
		model: asString(frontmatter.model),
		lifetime: lifetime && (LIFETIMES as readonly string[]).includes(lifetime) ? (lifetime as Lifetime) : undefined,
		concurrency: asCount(frontmatter.concurrency),
		openInHerdr: asBoolean(frontmatter.openInHerdr),
		source,
		filePath,
	};
}

/**
 * Discovers the available agents.
 *
 * The scope defaults to `"user"`, and that is not a detail: project agents
 * (`.pi/agents/`) are repository-controlled content, hence third-party
 * instructions. They are only loaded on explicit request.
 *
 * Precedence runs from the least specific to the most: the shipped definitions
 * first when `builtin` is set, then the user's, then the repository's. Whoever
 * is closer to the work wins the name. `builtin` is off by default: a script
 * that asks for "the user's agents" must not be handed ours as well. The
 * extension asks for them, because there it is the difference between working
 * out of the box and not working at all.
 *
 * Discovery happens on every call: editing a `.md` is enough to reload it.
 */
export function loadAgents(options: { cwd?: string; scope?: AgentScope; builtin?: boolean } = {}): Agent[] {
	const byName = new Map<string, Agent>();
	for (const { dir, source } of definitionDirs(AGENTS_DIR, BUILTIN_AGENTS_DIR, options)) {
		for (const agent of loadAgentsFromDir(dir, source)) byName.set(agent.name, agent);
	}
	return [...byName.values()];
}

/**
 * Looks up an agent by name, or throws.
 *
 * An unknown agent name is a programming error, not a runtime failure: we do
 * not want a failed `Result` several steps later because of a typo in a
 * workflow.
 */
export function findAgent(agents: Agent[], name: string): Agent {
	const agent = agents.find((candidate) => candidate.name === name);
	if (agent) return agent;

	// An empty list almost always means the scope, not a typo: project agents
	// are not loaded by default. Say so, or the caller hunts for the wrong bug -
	// a model given "Loaded agents: none" concluded the repository had no agent
	// definitions at all.
	if (agents.length === 0) {
		throw new Error(
			`Unknown agent "${name}": no agents were loaded. User agents live in ${path.join(getAgentDir(), AGENTS_DIR)}; ` +
				`project agents in ${CONFIG_DIR_NAME}/${AGENTS_DIR} are only loaded with scope "project" or "both".`,
		);
	}
	throw new Error(`Unknown agent "${name}". Loaded agents: ${agents.map((candidate) => candidate.name).join(", ")}`);
}

/**
 * Reads every `.md` in a directory.
 *
 * A file that does not parse is **dropped in silence** - that is pi's own
 * behaviour for an agent, and we keep it. A missing or unreadable directory
 * yields `[]`.
 */
export function loadAgentsFromDir(dir: string, source: AgentSource): Agent[] {
	const agents: Agent[] = [];
	for (const file of readMarkdownDir(dir)) {
		const agent = parseAgent(file.content, file.filePath, source);
		if (agent) agents.push(agent);
	}
	return agents;
}
