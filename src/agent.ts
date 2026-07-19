/**
 * An agent is *content*: a system prompt, a model, a set of tools.
 * It is declared as Markdown + frontmatter, following the pi convention.
 *
 * This file knows nothing about sessions or workflows: it turns files into
 * data. Bringing an agent to life is `spawn()`'s job.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Lifetime of a subagent - the central choice of this library.
 *
 * - `"task"`: born and dies with each task. Minimal context, reproducible.
 * - `"workflow"`: lives for the duration of the workflow. Remembers iterations.
 * - `"session"`: lives as long as the pi session. Long memory, watch it.
 */
export type Lifetime = "task" | "workflow" | "session";

const LIFETIMES: readonly string[] = ["task", "workflow", "session"];

/** Where an agent definition came from. */
export type AgentSource = "user" | "project";

/** Where to look for definitions. Defaults to `"user"` - see {@link loadAgents}. */
export type AgentScope = "user" | "project" | "both";

/** An agent: the "who". Inert data, no state, no session. */
export type Agent = {
	name: string;
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
 * With `"both"`, a project agent shadows the user agent of the same name.
 * Discovery happens on every call: editing a `.md` is enough to reload it.
 */
export function loadAgents(options: { cwd?: string; scope?: AgentScope } = {}): Agent[] {
	const cwd = options.cwd ?? process.cwd();
	const scope = options.scope ?? "user";

	const byName = new Map<string, Agent>();

	if (scope !== "project") {
		for (const agent of loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user")) {
			byName.set(agent.name, agent);
		}
	}
	if (scope !== "user") {
		const projectDir = findProjectAgentsDir(cwd);
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

/** Reads every `.md` in a directory. A missing or unreadable directory yields `[]`. */
export function loadAgentsFromDir(dir: string, source: AgentSource): Agent[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: Agent[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const agent = parseAgent(content, filePath, source);
		if (agent) agents.push(agent);
	}
	return agents;
}

/** Walks up parent directories to the first `.pi/agents/`. */
function findProjectAgentsDir(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// not here, walk up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Frontmatter is YAML-ish: a flag may arrive as a boolean or as the text "true". */
function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}
