/**
 * A flow's catalogue read from disk: where flows and agents are found, which
 * one wins a name, and the agent faults only a catalogue on disk can raise.
 *
 * The user's directory is reached through `PI_CODING_AGENT_DIR`, the variable
 * pi itself reads, pointed inside each test's own root.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { loadAgents } from "../src/agent.ts";
import { checkFlow, loadFlowCatalogue } from "../src/flow/index.ts";

const tmpDirs: string[] = [];
const agentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
	if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDir;
});

/** A root holding `files` by path, with the user's directory at `home/`. */
function root(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-flow-catalogue-"));
	tmpDirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "home");
	for (const [file, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), content);
	}
	return dir;
}

function agent(name: string, frontmatter = ""): string {
	return `---\nname: ${name}\ndescription: the ${name}\n${frontmatter}---\nYou are the ${name}.`;
}

/** A flow `f` whose one node, `go`, is written as `node`. */
function flow(node: string, input = "string"): string {
	return `---\nname: f\ndescription: d\ninput: ${input}\nnodes:\n  - id: go\n${node}\n---\n## go\nGo.\n`;
}

function skill(name: string, frontmatter = ""): string {
	return `---\nname: ${name}\ndescription: the ${name} skill\n${frontmatter}---\nDo the thing.\n`;
}

/** The faults of flow `f` in the catalogue of `cwd`, as `code at`. */
function faults(cwd: string): string[] {
	const result = checkFlow("f", loadFlowCatalogue({ cwd, scope: "both" }));
	assert.ok(!result.ok, "expected the flow to be refused");
	return result.faults.map(({ code, at }) => `${code} ${at}`);
}

describe("loadFlowCatalogue, where flows are", () => {
	test("the user's and the repository's, the repository winning a name", () => {
		const cwd = root({
			"home/flows/a.md": "mine",
			"home/flows/b.md": "mine",
			".pi/flows/b.md": "the repository's",
		});
		const flows = loadFlowCatalogue({ cwd, scope: "both" }).flows;
		assert.deepEqual(flows.map(({ name, content }) => `${name}: ${content}`), ["a: mine", "b: the repository's"]);
	});

	test('scope defaults to "user": a repository\'s flows are not read by accident', () => {
		const cwd = root({ ".pi/flows/b.md": "the repository's" });
		assert.deepEqual(loadFlowCatalogue({ cwd }).flows, []);
		assert.deepEqual(loadFlowCatalogue({ cwd, scope: "project" }).flows.map(({ name }) => name), ["b"]);
	});

	test("the catalogue carries the directory it was loaded for", () => {
		const cwd = root({});
		assert.equal(loadFlowCatalogue({ cwd }).cwd, cwd);
	});
});

describe("loadFlowCatalogue, the agents", () => {
	test("keeps a file that is not an agent, with its cause, under the name it would be asked for", () => {
		const cwd = root({
			"home/agents/good.md": agent("good"),
			"home/agents/nodesc.md": "---\nname: terse\n---\nNo description.",
			"home/agents/yaml.md": "---\nname: [oops\n---\nBody.",
		});
		const { agents, brokenAgents } = loadFlowCatalogue({ cwd });
		assert.deepEqual(agents.map(({ name }) => name), ["good"]);
		assert.deepEqual(brokenAgents.map(({ name, source }) => `${name} ${source}`), ["terse user", "yaml user"]);
		assert.match(brokenAgents[0]?.error ?? "", /`description:`/);
		assert.match(brokenAgents[1]?.error ?? "", /not valid YAML.*line 2/);
	});

	test("a broken file wins its name like any other, where loadAgents still drops it", () => {
		const cwd = root({ "home/agents/scout.md": agent("scout"), ".pi/agents/scout.md": "---\nname: scout\n---\n" });
		const catalogue = loadFlowCatalogue({ cwd, scope: "both" });
		assert.deepEqual(catalogue.agents, []);
		assert.deepEqual(catalogue.brokenAgents.map(({ name, source }) => `${name} ${source}`), ["scout project"]);
		assert.deepEqual(loadAgents({ cwd, scope: "both" }).map(({ name, source }) => `${name} ${source}`), ["scout user"]);
	});
});

describe("checkFlow, the agents of a catalogue on disk", () => {
	test("a flow on disk passes against its agents", () => {
		const cwd = root({ ".pi/flows/f.md": flow("    agent: scout"), ".pi/agents/scout.md": agent("scout") });
		const result = checkFlow("f", loadFlowCatalogue({ cwd, scope: "both" }));
		assert.ok(result.ok, JSON.stringify(!result.ok && result.faults));
	});

	test("a name matching a broken file is that file broken, with its path and cause, not unknown", () => {
		const cwd = root({ ".pi/flows/f.md": flow("    agent: scout"), ".pi/agents/scout.md": "---\nname: scout\n---\n" });
		const result = checkFlow("f", loadFlowCatalogue({ cwd, scope: "both" }));
		assert.ok(!result.ok);
		assert.deepEqual(result.faults.map(({ code, at }) => `${code} ${at}`), ["broken-agent go.agent"]);
		assert.ok(result.faults[0]?.message.includes(path.join(cwd, ".pi", "agents", "scout.md")), result.faults[0]?.message);
		assert.match(result.faults[0]?.message ?? "", /`description:`/);
	});

	test("each member of an `among:` too", () => {
		const cwd = root({
			".pi/flows/f.md": flow("    agent-from: input\n    among: [scout, reviewer]", "scout | reviewer"),
			".pi/agents/scout.md": "---\nname: [scout\n---\n",
			".pi/agents/reviewer.md": agent("reviewer"),
		});
		assert.deepEqual(faults(cwd), ["broken-agent go.among"]);
	});

	test("an agent declaring skills needs `read`, and each skill has to be found", () => {
		const cwd = root({
			".pi/flows/f.md": flow("    agent: scout"),
			".pi/agents/scout.md": agent("scout", "tools: grep\nskills: diffing\n"),
		});
		assert.deepEqual(faults(cwd), ["skills-without-read go.agent", "unknown-skill go.agent"]);
	});

	test("a skill resolves beside its agent, in the repository or in the user's directory", () => {
		const cwd = root({
			".pi/flows/f.md": flow("    agent: scout"),
			".pi/agents/scout.md": agent("scout", "skills: own, shared, personal\n"),
			".pi/agents/scout/skills/own/SKILL.md": skill("own"),
			".pi/skills/shared/SKILL.md": skill("shared"),
			"home/skills/personal/SKILL.md": skill("personal"),
		});
		const result = checkFlow("f", loadFlowCatalogue({ cwd, scope: "both" }));
		assert.ok(result.ok, JSON.stringify(!result.ok && result.faults));
	});

	test("a skill pi would keep out of the prompt is refused", () => {
		const cwd = root({
			".pi/flows/f.md": flow("    agent: scout"),
			".pi/agents/scout.md": agent("scout", "skills: secret\n"),
			".pi/skills/secret/SKILL.md": skill("secret", "disable-model-invocation: true\n"),
		});
		assert.deepEqual(faults(cwd), ["skill-hidden go.agent"]);
	});
});
