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
import { asBoolean, asString, findProjectDir, readMarkdownDir } from "./markdown.ts";

/**
 * Lifetime of a subagent - the central choice of this library.
 *
 * - `"task"`: born and dies with each task. Minimal context, reproducible.
 * - `"workflow"`: lives for the duration of the workflow. Remembers iterations.
 * - `"session"`: lives as long as the pi session. Long memory, watch it.
 */
export type Lifetime = "task" | "workflow" | "session";

const LIFETIMES: readonly string[] = ["task", "workflow", "session"];

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
	/** Model pattern, e.g. `"anthropic/claude-sonnet-5"`. Absent means pi's default. */
	model?: string;
	/** Default lifetime. An explicit call always wins. */
	lifetime?: Lifetime;
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
 * Parses an agent definition.
 *
 * Returns `undefined` when `name` or `description` is missing: this is pi's
 * behaviour, an incomplete file is ignored **silently**. Kept separate from
 * {@link loadAgents} so it stays testable without touching the disk.
 */
export function parseAgent(content: string, filePath: string, source: AgentSource): Agent | undefined {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

	const name = asString(frontmatter.name);
	const description = asString(frontmatter.description);
	if (!name || !description) return undefined;

	const tools = asString(frontmatter.tools)
		?.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);

	const lifetime = asString(frontmatter.lifetime);

	return {
		name,
		description,
		systemPrompt: body.trim(),
		tools: tools && tools.length > 0 ? tools : undefined,
		model: asString(frontmatter.model),
		lifetime: lifetime && LIFETIMES.includes(lifetime) ? (lifetime as Lifetime) : undefined,
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
 * is closer to the work wins the name.
 *
 * Discovery happens on every call: editing a `.md` is enough to reload it.
 */
export function loadAgents(options: { cwd?: string; scope?: AgentScope; builtin?: boolean } = {}): Agent[] {
	const cwd = options.cwd ?? process.cwd();
	const scope = options.scope ?? "user";

	const byName = new Map<string, Agent>();

	// Off by default: a script that asks for "the user's agents" must not be
	// handed ours as well. The extension asks for them, because there it is the
	// difference between working out of the box and not working at all.
	if (options.builtin) {
		for (const agent of loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin")) byName.set(agent.name, agent);
	}
	if (scope !== "project") {
		for (const agent of loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user")) {
			byName.set(agent.name, agent);
		}
	}
	if (scope !== "user") {
		const projectDir = findProjectDir(cwd, "agents");
		if (projectDir) {
			for (const agent of loadAgentsFromDir(projectDir, "project")) {
				byName.set(agent.name, agent);
			}
		}
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
			`Unknown agent "${name}": no agents were loaded. User agents live in ${path.join(getAgentDir(), "agents")}; ` +
				`project agents in ${CONFIG_DIR_NAME}/agents are only loaded with scope "project" or "both".`,
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
