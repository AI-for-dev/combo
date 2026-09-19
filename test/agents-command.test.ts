/**
 * `/agents`, with the roster injected.
 *
 * What is tested is what the user is *told*: which source won a name, the
 * directory each source was read from, and the one thing the listing exists to
 * prevent - a repository's agent sitting there, listed, out of the subagent
 * tool's reach until it is asked for by scope.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, test } from "node:test";
import { getAgentDir, initTheme } from "@earendil-works/pi-coding-agent";
import { agentLines, groupAgents, listAgents } from "../extension/agents-command.ts";
import type { CommandCtx } from "../extension/command.ts";
import type { Agent } from "../src/index.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

initTheme();

const shipped = testAgent("coder", { source: "builtin", filePath: "/pkg/combo/agents/coder.md" });
const mine = testAgent("notetaker", { source: "user", filePath: "/home/me/.pi/agent/agents/notetaker.md" });
const ours = testAgent("scout", { source: "project", filePath: "/repo/.pi/agents/scout.md" });

function fakeCtx(agents: Agent[]) {
	const notes: string[] = [];
	const ctx = {
		cwd: "/repo",
		ui: { notify: (message: string) => void notes.push(message) },
	} as unknown as CommandCtx;
	return { ctx, notes, deps: { loadAgents: () => agents } };
}

describe("groupAgents", () => {
	test("splits by source, most specific first, naming the directory each came from", () => {
		const groups = groupAgents([shipped, mine, ours], "/repo");

		assert.deepEqual(
			groups.map(({ source, where }) => [source, where]),
			[
				["project", "/repo/.pi/agents"],
				["user", "/home/me/.pi/agent/agents"],
				["builtin", "/pkg/combo/agents"],
			],
		);
	});

	test("a source that turned up nothing still says where it looked", () => {
		const [project, user] = groupAgents([shipped], "/repo");

		assert.deepEqual(project?.agents, []);
		assert.equal(project?.where, path.join("/repo", ".pi", "agents"));
		assert.equal(user?.where, path.join(getAgentDir(), "agents"));
	});

	test("a name defined twice is listed once, under the source that won it", () => {
		// What `loadAgents` hands over: precedence is already applied, so a
		// project `coder` arrives as one agent with source "project".
		const overridden = testAgent("coder", { source: "project", filePath: "/repo/.pi/agents/coder.md" });
		const groups = groupAgents([overridden, mine], "/repo");

		assert.deepEqual(
			groups.map(({ agents }) => agents.map((agent) => agent.name)),
			[["coder"], ["notetaker"], []],
		);
	});
});

describe("agentLines", () => {
	test("one line per agent: its name, then what it is for", () => {
		const lines = agentLines([shipped, mine, ours], "/repo");

		assert.match(lines.join("\n"), /^project · \/repo\/\.pi\/agents$/m);
		assert.match(lines.join("\n"), /^ {2}scout\s+scout for tests$/m);
		assert.match(lines.join("\n"), /^ {2}coder\s+coder for tests$/m);
	});

	test("an empty source reads as empty rather than as missing", () => {
		const lines = agentLines([shipped], "/repo");
		assert.equal(lines.filter((line) => line === "  (none)").length, 2);
	});

	test("says how to reach a project agent, and only when there is one", () => {
		const withProject = agentLines([shipped, ours], "/repo").join("\n");
		assert.match(withProject, /scope "project" or "both"/);

		const without = agentLines([shipped, mine], "/repo").join("\n");
		assert.doesNotMatch(without, /scope "project" or "both"/);
	});
});

describe("listAgents", () => {
	test("shows the roster the commands themselves load", () => {
		const { ctx, notes, deps } = fakeCtx([shipped, mine, ours]);

		const lines = listAgents(ctx, deps);

		assert.equal(notes.length, 1);
		assert.equal(notes[0], lines.join("\n"));
		assert.match(notes[0] ?? "", /scout/);
	});

	test("an empty roster is a listing of three empty sources, not an error", () => {
		const { ctx, deps } = fakeCtx([]);

		const lines = listAgents(ctx, deps);

		assert.equal(lines.filter((line) => line === "  (none)").length, 3);
	});
});
