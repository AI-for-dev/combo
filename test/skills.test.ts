/**
 * Skill resolution: the disk, and nothing else.
 *
 * No session is involved - a skill is found before pi is ever opened, which is
 * the whole reason a typo in a definition fails at spawn rather than halfway
 * through a workflow. The user's directory is reached through
 * `PI_CODING_AGENT_DIR`, the same variable pi itself reads.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import type { Agent } from "../src/agent.ts";
import { resolveSkills, skillDirs } from "../src/skills.ts";

const tmpDirs: string[] = [];
const agentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
	if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDir;
});

/** A throwaway root, with `PI_CODING_AGENT_DIR` pointed inside it. */
function tmpRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-skills-"));
	tmpDirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "home", "agent");
	return dir;
}

/** Writes a `SKILL.md` under `<dir>/<name>/`, with the body as its description. */
function writeSkill(dir: string, name: string, description: string, frontmatter = ""): string {
	const skillDir = path.join(dir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	const filePath = path.join(skillDir, "SKILL.md");
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n${frontmatter}---\n\nDo the thing.\n`);
	return filePath;
}

function agentAt(filePath: string, skills?: string[]): Agent {
	return { name: "scout", description: "Locates code", systemPrompt: "You scout.", skills, source: "user", filePath };
}

describe("skillDirs", () => {
	test("searches the agent's own directory, then the project, then the user", () => {
		const root = tmpRoot();
		fs.mkdirSync(path.join(root, ".pi", "skills"), { recursive: true });

		const dirs = skillDirs(agentAt(path.join(root, "agents", "scout.md")), root);

		assert.deepEqual(dirs, [
			{ dir: path.join(root, "agents", "scout", "skills"), source: "agent" },
			{ dir: path.join(root, ".pi", "skills"), source: "project" },
			{ dir: path.join(root, "home", "agent", "skills"), source: "user" },
		]);
	});

	test("an agent with no definition file has no directory of its own", () => {
		const root = tmpRoot();
		const dirs = skillDirs(agentAt("(built in memory)"), root);
		assert.deepEqual(
			dirs.map(({ source }) => source),
			["user"],
		);
	});
});

describe("resolveSkills", () => {
	test("returns nothing, and reads nothing, when the definition names none", () => {
		assert.deepEqual(resolveSkills(agentAt("/nowhere/scout.md"), "/nowhere", []), []);
	});

	test("finds a skill shipped beside the definition", () => {
		const root = tmpRoot();
		const filePath = writeSkill(path.join(root, "agents", "scout", "skills"), "diffing", "Reads a diff");

		const [skill, ...rest] = resolveSkills(agentAt(path.join(root, "agents", "scout.md"), ["diffing"]), root, ["read"]);

		assert.ok(skill);
		assert.deepEqual(rest, []);
		assert.equal(skill.name, "diffing");
		assert.equal(skill.description, "Reads a diff");
		assert.equal(skill.filePath, filePath);
	});

	test("falls back to the project's skills, then to the user's", () => {
		const root = tmpRoot();
		writeSkill(path.join(root, ".pi", "skills"), "diffing", "From the project");
		writeSkill(path.join(root, "home", "agent", "skills"), "humanising", "From the user");

		const agent = agentAt(path.join(root, "agents", "scout.md"), ["humanising", "diffing"]);
		const skills = resolveSkills(agent, root, ["read"]);

		// Declaration order, not discovery order.
		assert.deepEqual(
			skills.map(({ description }) => description),
			["From the user", "From the project"],
		);
	});

	test("the nearest directory wins the name", () => {
		const root = tmpRoot();
		writeSkill(path.join(root, "agents", "scout", "skills"), "diffing", "From the agent");
		writeSkill(path.join(root, ".pi", "skills"), "diffing", "From the project");
		writeSkill(path.join(root, "home", "agent", "skills"), "diffing", "From the user");

		const [skill] = resolveSkills(agentAt(path.join(root, "agents", "scout.md"), ["diffing"]), root, ["read"]);

		assert.equal(skill?.description, "From the agent");
	});

	test("an unknown skill fails at spawn, naming where it was looked for", () => {
		const root = tmpRoot();
		const agent = agentAt(path.join(root, "agents", "scout.md"), ["diffing"]);

		assert.throws(() => resolveSkills(agent, root, ["read"]), /unknown skill\(s\) diffing/);
		assert.throws(() => resolveSkills(agent, root, ["read"]), /Looked in:.*scout[/\\]skills/);
	});

	test("an unknown skill names the skills found, and the nearest one", () => {
		const root = tmpRoot();
		writeSkill(path.join(root, "agents", "scout", "skills"), "diffing", "Reads a diff");
		writeSkill(path.join(root, ".pi", "skills"), "linting", "Reads lint");
		const agent = agentAt(path.join(root, "agents", "scout.md"), ["difing"]);

		assert.throws(() => resolveSkills(agent, root, ["read"]), /did you mean "diffing"\? Skills found: diffing, linting\./);
	});

	test("a directory named like the skill, whose SKILL.md names another, is said plainly", () => {
		const root = tmpRoot();
		const skills = path.join(root, "agents", "scout", "skills");
		writeSkill(skills, "assertion-smell", "Spots weak assertions");
		fs.writeFileSync(path.join(skills, "assertion-smell", "SKILL.md"), "---\nname: assertion-smells\ndescription: Spots weak assertions\n---\n");
		const agent = agentAt(path.join(root, "agents", "scout.md"), ["assertion-smell"]);

		assert.throws(
			() => resolveSkills(agent, root, ["read"]),
			(error: Error) =>
				error.message.includes(`${path.join(skills, "assertion-smell", "SKILL.md")} is named "assertion-smells"`) &&
				error.message.includes("Skills found: assertion-smells."),
		);
	});

	test("an unknown skill where there is none says so", () => {
		const root = tmpRoot();
		const agent = agentAt(path.join(root, "agents", "scout.md"), ["diffing"]);

		assert.throws(() => resolveSkills(agent, root, ["read"]), /No skill was found\. Looked in:/);
	});

	test("a skill the agent could not open is a configuration error, not a silence", () => {
		const root = tmpRoot();
		writeSkill(path.join(root, "agents", "scout", "skills"), "diffing", "Reads a diff");
		const agent = agentAt(path.join(root, "agents", "scout.md"), ["diffing"]);

		// pi hides the whole section from a session without `read`.
		assert.throws(() => resolveSkills(agent, root, ["grep", "ls"]), /no "read" tool/);
	});

	test("a skill hidden from the model is refused rather than offered in vain", () => {
		const root = tmpRoot();
		writeSkill(path.join(root, "agents", "scout", "skills"), "diffing", "Reads a diff", "disable-model-invocation: true\n");
		const agent = agentAt(path.join(root, "agents", "scout.md"), ["diffing"]);

		assert.throws(() => resolveSkills(agent, root, ["read"]), /disable-model-invocation/);
	});
});
