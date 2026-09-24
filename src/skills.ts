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
 * skill the model cannot reach is a configuration error rather than a silence
 * at runtime: a flow's validation reports it, and spawn throws it.
 */

import * as path from "node:path";
import { getAgentDir, loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { Agent } from "./agent.ts";
import { findProjectDir } from "./markdown.ts";
import { nearest } from "./nearest.ts";

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

/** Every code a {@link SkillProblem} can carry, in the order they are found. */
export const SKILL_CODES = ["skills-without-read", "unknown-skill", "skill-hidden"] as const;

/** One reason an agent's `skills:` cannot be handed to it. */
export type SkillProblem = { readonly code: (typeof SKILL_CODES)[number]; readonly message: string };

/**
 * What an agent's `skills:` names, looked up nearest first, and every reason
 * one of them would never reach the model: a toolset without `read` (pi hides
 * the whole section), a name found nowhere, and a skill whose frontmatter says
 * `disable-model-invocation` (pi hides that one).
 *
 * The one lookup, for the two callers that must agree on it: spawn, which
 * throws the first problem, and a flow's validation, which reports them all
 * before anything runs. `skills` is in declaration order and holds what was
 * found, problems or not.
 */
export function findSkills(agent: Agent, cwd: string, tools: readonly string[]): { skills: Skill[]; problems: SkillProblem[] } {
	// A set: a name written twice is one skill, not one advertised twice.
	const names = [...new Set(agent.skills ?? [])];
	if (names.length === 0) return { skills: [], problems: [] };

	const problems: SkillProblem[] = [];
	if (!tools.includes("read")) {
		problems.push({ code: "skills-without-read", message: `Agent "${agent.name}" declares skills but has no "read" tool: it could not open one.` });
	}

	const dirs = skillDirs(agent, cwd);
	const found = new Map<string, Skill>();
	const seen: Skill[] = [];
	for (const { dir, source } of dirs) {
		for (const skill of loadSkillsFromDir({ dir, source }).skills) {
			seen.push(skill);
			// The nearest directory wins the name, and so does the first file
			// that carries it within one directory.
			if (names.includes(skill.name) && !found.has(skill.name)) found.set(skill.name, skill);
		}
		if (found.size === names.length) break;
	}

	const missing = names.filter((name) => !found.has(name));
	if (missing.length > 0) {
		const present = [...new Set(seen.map((skill) => skill.name))];
		const message = [
			`Agent "${agent.name}" declares unknown skill(s) ${missing.join(", ")}.`,
			...missing.flatMap((name) => hint(name, seen) ?? []),
			present.length === 0 ? "No skill was found." : `Skills found: ${present.join(", ")}.`,
			`Looked in: ${dirs.map(({ dir }) => dir).join(", ")}.`,
		].join(" ");
		problems.push({ code: "unknown-skill", message });
	}

	const hidden = names.filter((name) => found.get(name)?.disableModelInvocation);
	if (hidden.length > 0) {
		const message =
			`Agent "${agent.name}" declares skill(s) ${hidden.join(", ")}, which set "disable-model-invocation": ` +
			"pi keeps those out of the system prompt, so the agent would never see them.";
		problems.push({ code: "skill-hidden", message });
	}

	// Declaration order, not discovery order: the definition decides what the
	// prompt says, and a run is the same whatever the filesystem returns.
	return { skills: names.flatMap((name) => found.get(name) ?? []), problems };
}

/**
 * What was probably meant by a skill name found nowhere. A directory named
 * like it comes first: pi names a skill after its `SKILL.md` frontmatter, not
 * its directory, so renaming the directory never fixes it.
 */
function hint(name: string, seen: readonly Skill[]): string | undefined {
	const misnamed = seen.find((skill) => path.basename(skill.baseDir) === name);
	if (misnamed) return `${misnamed.filePath} is named "${misnamed.name}": a skill goes by the name in its SKILL.md, not its directory's, so declare "${misnamed.name}" or change that name.`;
	const near = nearest(name, seen.map((skill) => skill.name));
	return near === undefined ? undefined : `"${name}": did you mean "${near}"?`;
}

/**
 * Resolves what an agent's `skills:` names, in the order it named them.
 *
 * Throws rather than dropping one: a missing skill is a typo in a definition,
 * and finding out through prose that quietly lacks a step costs more than
 * failing at spawn. A TypeScript workflow has no validation before it runs, so
 * this is where it finds out; a flow found out before its first spawn.
 */
export function resolveSkills(agent: Agent, cwd: string, tools: readonly string[]): Skill[] {
	const { skills, problems } = findSkills(agent, cwd, tools);
	if (problems[0] !== undefined) throw new Error(problems[0].message);
	return skills;
}
