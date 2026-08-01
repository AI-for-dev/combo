import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { findAgent, loadAgents, loadAgentsFromDir, parseAgent } from "../src/agent.ts";

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpAgentsDir(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-"));
	tmpDirs.push(dir);
	const agentsDir = path.join(dir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(agentsDir, name), content);
	}
	return dir;
}

describe("parseAgent", () => {
	test("reads frontmatter and uses the body as the system prompt", () => {
		const agent = parseAgent(
			[
				"---",
				"name: reviewer",
				"description: Reviews code",
				"tools: read, grep,  find ",
				"model: anthropic/claude-sonnet-5",
				"lifetime: workflow",
				"---",
				"",
				"You review code.",
			].join("\n"),
			"/x/reviewer.md",
			"user",
		);

		assert.equal(agent?.name, "reviewer");
		assert.equal(agent?.description, "Reviews code");
		assert.deepEqual(agent?.tools, ["read", "grep", "find"]);
		assert.equal(agent?.model, "anthropic/claude-sonnet-5");
		assert.equal(agent?.lifetime, "workflow");
		assert.equal(agent?.systemPrompt, "You review code.");
		assert.equal(agent?.source, "user");
	});

	test("ignores a definition without name or description", () => {
		assert.equal(parseAgent("---\ndescription: no name\n---\nbody", "/x/a.md", "user"), undefined);
		assert.equal(parseAgent("---\nname: nodesc\n---\nbody", "/x/b.md", "user"), undefined);
		assert.equal(parseAgent("no frontmatter at all", "/x/c.md", "user"), undefined);
	});

	test("leaves tools and model undefined when absent, so spawn applies its defaults", () => {
		const agent = parseAgent("---\nname: a\ndescription: d\ntools:   \n---\nbody", "/x/a.md", "user");
		assert.equal(agent?.tools, undefined);
		assert.equal(agent?.model, undefined);
		assert.equal(agent?.lifetime, undefined);
	});

	test("reads openInHerdr, as a boolean or as the text a YAML-ish parser yields", () => {
		const yes = parseAgent("---\nname: a\ndescription: d\nopenInHerdr: true\n---\nbody", "/x/a.md", "user");
		assert.equal(yes?.openInHerdr, true);

		const no = parseAgent("---\nname: a\ndescription: d\nopenInHerdr: false\n---\nbody", "/x/a.md", "user");
		assert.equal(no?.openInHerdr, false);

		const absent = parseAgent("---\nname: a\ndescription: d\n---\nbody", "/x/a.md", "user");
		assert.equal(absent?.openInHerdr, undefined, "absent must stay absent, so the caller's choice can win");
	});

	test("rejects an unknown lifetime rather than passing it through", () => {
		const agent = parseAgent("---\nname: a\ndescription: d\nlifetime: forever\n---\nbody", "/x/a.md", "user");
		assert.equal(agent?.lifetime, undefined);
	});
});

describe("loadAgentsFromDir", () => {
	test("reads .md files and skips everything else", () => {
		const dir = tmpAgentsDir({
			"good.md": "---\nname: good\ndescription: d\n---\nbody",
			"incomplete.md": "---\ndescription: no name\n---\nbody",
			"notes.txt": "---\nname: ignored\ndescription: d\n---\nbody",
		});

		const agents = loadAgentsFromDir(path.join(dir, ".pi", "agents"), "project");
		assert.deepEqual(
			agents.map((agent) => agent.name),
			["good"],
		);
		assert.equal(agents[0]?.source, "project");
	});

	test("a missing directory yields an empty list, not an error", () => {
		assert.deepEqual(loadAgentsFromDir("/definitely/not/here", "user"), []);
	});
});

describe("loadAgents", () => {
	test('scope defaults to "user": project agents are not loaded by accident', () => {
		const dir = tmpAgentsDir({ "proj.md": "---\nname: proj\ndescription: d\n---\nbody" });

		const names = loadAgents({ cwd: dir }).map((agent) => agent.name);
		assert.equal(names.includes("proj"), false);
	});

	test('scope "project" walks up to the nearest .pi/agents', () => {
		const dir = tmpAgentsDir({ "proj.md": "---\nname: proj\ndescription: d\n---\nbody" });
		const nested = path.join(dir, "src", "deep");
		fs.mkdirSync(nested, { recursive: true });

		const agents = loadAgents({ cwd: nested, scope: "project" });
		assert.deepEqual(
			agents.map((agent) => agent.name),
			["proj"],
		);
	});

	test("the agents shipped here are off unless asked for", () => {
		const dir = tmpAgentsDir({});

		assert.deepEqual(loadAgents({ cwd: dir, scope: "project" }), [], "a script asking for the user's agents gets no others");
		assert.ok(
			loadAgents({ cwd: dir, scope: "project", builtin: true }).some((agent) => agent.name === "scout"),
			"the extension asks for them: without that it works only where they were copied by hand",
		);
	});

	test("a repository's agent replaces a shipped one of the same name", () => {
		const dir = tmpAgentsDir({
			"scout.md": "---\nname: scout\ndescription: mine\n---\nMy own scout.",
		});

		const agents = loadAgents({ cwd: dir, scope: "project", builtin: true });
		const scouts = agents.filter((agent) => agent.name === "scout");

		assert.equal(scouts.length, 1, "one name, one agent");
		assert.equal(scouts[0]?.description, "mine", "whoever is closer to the work wins the name");
		assert.equal(scouts[0]?.source, "project");
		assert.ok(agents.some((agent) => agent.name === "planner"), "and the shipped ones it does not override remain");
	});
});

describe("findAgent", () => {
	const agents = [parseAgent("---\nname: a\ndescription: d\n---\nb", "/x/a.md", "user")!];

	test("finds by name", () => {
		assert.equal(findAgent(agents, "a").name, "a");
	});

	test("throws on an unknown name: a typo must not become a failed Result later", () => {
		assert.throws(() => findAgent(agents, "nope"), /Unknown agent "nope"/);
		assert.throws(() => findAgent(agents, "nope"), /Loaded agents: a/);
	});

	test("an empty list blames the scope, not the name", () => {
		// "Loaded agents: none" once led a model to conclude the repository had
		// no agent definitions at all. Point at the real cause instead.
		assert.throws(() => findAgent([], "scout"), /no agents were loaded/);
		assert.throws(() => findAgent([], "scout"), /scope "project" or "both"/);
	});
});
