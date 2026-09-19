/**
 * The skills an agent may load, and where they are looked up.
 *
 * A skill is **named in a definition, never inherited from the machine**:
 * `skills:` is an allowlist exactly like `tools:`, so what an agent can do
 * stays readable in its own file. Only the *lookup* reaches outside, nearest
 * first: the skill shipped beside the definition, then the repository's, then
 * the user's. Whoever is closest to the work wins the name.
 *
 * pi does the rest: the system prompt carries a name, a description and a path,
 * and the model opens `SKILL.md` itself with `read`. That is why a declared
 * skill the model cannot reach is a configuration error here rather than a
 * silence at runtime.
 */

import * as path from "node:path";
import { getAgentDir, loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agent.ts";
import { findProjectDir } from "./markdown.ts";

/** Alias to pi's skill type, so a caller names it without importing pi. */
export type { Skill };

/** A directory to search, and the label pi records for what it finds there. */
export type SkillDir = {
	/** Absolute path of the directory. It legitimately may not exist. */
	dir: string;
	/** Where a skill found here came from: `"agent"`, `"project"` or `"user"`. */
	source: string;
};

/**
 * The directories a declared skill is looked up in, **nearest first**.
 *
 * The agent's own directory is `<definition>/skills/`: `agents/scout.md` keeps
 * its skills in `agents/scout/skills/`, so a definition and what it needs
 * travel together and a clone of the repository resolves the same names. An
 * agent built in memory has no definition file and therefore no own directory.
 *
 * The other two are the project's and the user's, and they are the deliberate
 * hole in "a subagent inherits nothing": a name still has to be written in the
 * definition, but where it resolves depends on the machine. A skill that must
 * run anywhere ships beside its agent.
 */
export function skillDirs(agent: Agent, cwd: string): SkillDir[] {
	const dirs: SkillDir[] = [];
	if (agent.filePath.endsWith(".md")) {
		dirs.push({ dir: path.join(agent.filePath.slice(0, -".md".length), "skills"), source: "agent" });
	}
	const projectDir = findProjectDir(cwd, "skills");
	if (projectDir) dirs.push({ dir: projectDir, source: "project" });
	dirs.push({ dir: path.join(getAgentDir(), "skills"), source: "user" });
	return dirs;
}

/**
 * Resolves what an agent's `skills:` names, in the order it named them.
 *
 * Throws rather than dropping one: a missing skill is a typo in a definition,
 * and finding out through prose that quietly lacks a step costs more than
 * failing at spawn. Same reason for the two ways a skill can resolve and still
 * never be seen - a toolset without `read` (pi hides the whole section), and a
 * skill whose frontmatter says `disable-model-invocation` (pi hides that one).
 */
export function resolveSkills(agent: Agent, cwd: string, tools: readonly string[]): Skill[] {
	// A set: a name written twice is one skill, not one advertised twice.
	const names = [...new Set(agent.skills ?? [])];
	if (names.length === 0) return [];

	if (!tools.includes("read")) {
		throw new Error(`Agent "${agent.name}" declares skills but has no "read" tool: it could not open one.`);
	}

	const dirs = skillDirs(agent, cwd);
	const found = new Map<string, Skill>();
	for (const { dir, source } of dirs) {
		for (const skill of loadSkillsFromDir({ dir, source }).skills) {
			// The nearest directory wins the name, and so does the first file
			// that carries it within one directory.
			if (names.includes(skill.name) && !found.has(skill.name)) found.set(skill.name, skill);
		}
		if (found.size === names.length) break;
	}

	const missing = names.filter((name) => !found.has(name));
	if (missing.length > 0) {
		throw new Error(
			`Agent "${agent.name}" declares unknown skill(s) ${missing.join(", ")}. ` +
				`Looked in: ${dirs.map(({ dir }) => dir).join(", ")}.`,
		);
	}

	const hidden = names.filter((name) => found.get(name)?.disableModelInvocation);
	if (hidden.length > 0) {
		throw new Error(
			`Agent "${agent.name}" declares skill(s) ${hidden.join(", ")}, which set "disable-model-invocation": ` +
				"pi keeps those out of the system prompt, so the agent would never see them.",
		);
	}

	// Declaration order, not discovery order: the definition decides what the
	// prompt says, and a run is the same whatever the filesystem returns.
	return names.map((name) => found.get(name) as Skill);
}
