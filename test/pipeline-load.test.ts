/**
 * Discovering pipelines on a real temporary directory.
 *
 * The filesystem is genuine here for the same reason it is in the export tests:
 * discovery whose only proof is a mocked `readdirSync` proves nothing about the
 * directory a user actually put a file in.
 *
 * The behaviour worth pinning down is the one that differs from agents: a file
 * that does not parse is neither dropped in silence nor allowed to take the
 * whole directory down with it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { loadAgentsFromDir } from "../src/agent.ts";
import { findPipeline, loadPipelines, loadPipelinesFromDir } from "../src/pipeline-load.ts";
import { checkPipelineAgents } from "../src/workflows/pipeline-run.ts";

const scratch: string[] = [];

function tmpDir(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-pipelines-"));
	scratch.push(dir);
	for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
	return dir;
}

/** A throwaway repository with its own `.pi/pipelines/`. */
function tmpProject(files: Record<string, string>): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "combo-project-"));
	scratch.push(repo);
	const dir = path.join(repo, ".pi", "pipelines");
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
	return repo;
}

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const GOOD = `---
name: build
description: The default delivery
verify: [npm, test]
steps:
  - id: work
    deliver: planner
    workers: [coder]
    reviewer: reviewer
---

## work

Do what the brief says.
`;

describe("loadPipelinesFromDir", () => {
	test("reads the pipelines that parse", () => {
		const found = loadPipelinesFromDir(tmpDir({ "build.md": GOOD }));

		assert.equal(found.pipelines.length, 1);
		assert.equal(found.pipelines[0]?.name, "build");
		assert.deepEqual(found.pipelines[0]?.verify, ["npm", "test"]);
		assert.deepEqual(found.broken, []);
	});

	test("a missing directory is not an error: most people have none", () => {
		const found = loadPipelinesFromDir(path.join(os.tmpdir(), "combo-does-not-exist"));
		assert.deepEqual(found, { pipelines: [], broken: [] });
	});

	test("one broken file does not hide the ones that work", () => {
		const found = loadPipelinesFromDir(tmpDir({ "build.md": GOOD, "wrong.md": "---\nname: wrong\n---\n" }));

		assert.deepEqual(
			found.pipelines.map((one) => one.name),
			["build"],
		);
		assert.equal(found.broken.length, 1);
		assert.equal(found.broken[0]?.name, "wrong");
		assert.match(found.broken[0]?.error ?? "", /non-empty "steps"/);
	});

	test("only .md files are read", () => {
		const found = loadPipelinesFromDir(tmpDir({ "build.md": GOOD, "notes.txt": "not a pipeline" }));
		assert.equal(found.pipelines.length, 1);
		assert.deepEqual(found.broken, []);
	});
});

describe("the pipelines this repository ships", () => {
	const root = path.join(import.meta.dirname, "..");

	test("every one of them parses, and names agents that exist", () => {
		const found = loadPipelinesFromDir(path.join(root, "pipelines"));
		const agents = loadAgentsFromDir(path.join(root, "agents"), "project");

		assert.deepEqual(found.broken, [], "a demo pipeline that does not parse teaches the wrong thing");
		assert.ok(found.pipelines.length > 0);
		for (const one of found.pipelines) checkPipelineAgents(one, agents);
	});

	test("there is one named build: /build has no other default", () => {
		const found = loadPipelinesFromDir(path.join(root, "pipelines"));
		assert.ok(
			found.pipelines.some((one) => one.name === "build"),
			"the package shipping no `build` pipeline breaks /build entirely - packaging must not drop it",
		);
	});

	test("the tarball carries the definitions the extension needs", () => {
		// `files` is what npm publishes. The loaders find `agents/` and
		// `pipelines/` inside the package, so dropping either from this list
		// breaks `/build` for every installed user while every test here still
		// passes - the repository has the files either way.
		const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { files?: string[] };
		for (const needed of ["src", "extension", "agents", "pipelines"]) {
			assert.ok(manifest.files?.includes(needed), `package.json "files" must list ${needed}`);
		}
	});

	test("the shipped build names no check: only the user knows what theirs is", () => {
		const found = loadPipelinesFromDir(path.join(root, "pipelines"));
		const build = found.pipelines.find((one) => one.name === "build");
		assert.equal(build?.verify, undefined, "`npm test` imposed on a project that has none is worse than asking");
	});

	test("they are reachable at pi's project location", () => {
		const linked = loadPipelinesFromDir(path.join(root, ".pi", "pipelines"));
		assert.deepEqual(
			linked.pipelines.map((one) => one.name).sort(),
			loadPipelinesFromDir(path.join(root, "pipelines")).pipelines.map((one) => one.name).sort(),
		);
	});
});

describe("precedence between the three sources", () => {
	test("a repository's build.md replaces the shipped one of the same name", () => {
		// The user directory is `~/.pi/agent/pipelines`, which a test has no
		// business writing to, so the rule is asserted on the two sources a test
		// can own: shipped, and the repository's.
		const repo = tmpProject({
			"build.md": '---\nname: build\nsteps:\n  - id: mine\n    chain: coder\n---\n\n## mine\nMy own.\n',
		});
		const catalogue = loadPipelines({ scope: "project", cwd: repo, builtin: true });
		const build = catalogue.pipelines.filter((one) => one.name === "build");

		assert.equal(build.length, 1, "one name, one pipeline - the shipped one is replaced, not duplicated");
		assert.equal(build[0]?.steps[0]?.id, "mine");
		assert.ok(
			catalogue.pipelines.some((one) => one.name === "explore"),
			"and the shipped ones it does not override are still there",
		);
	});

	test("the built-ins are off unless asked for: a script gets the user's agents, not ours", () => {
		const withoutBuiltin = loadPipelines({ scope: "project", cwd: os.tmpdir() });
		assert.deepEqual(withoutBuiltin.pipelines, []);

		const withBuiltin = loadPipelines({ scope: "project", cwd: os.tmpdir(), builtin: true });
		assert.ok(withBuiltin.pipelines.some((one) => one.name === "build"));
	});
});

describe("findPipeline", () => {
	test("finds one by the name in its frontmatter", () => {
		const catalogue = loadPipelinesFromDir(tmpDir({ "anything.md": GOOD }));
		assert.equal(findPipeline(catalogue, "build").name, "build");
	});

	test("a broken file reports why, rather than claiming it does not exist", () => {
		const catalogue = loadPipelinesFromDir(tmpDir({ "build.md": "---\nname: build\n---\n" }));
		assert.throws(() => findPipeline(catalogue, "build"), /does not parse: .*non-empty "steps"/);
	});

	test("an empty catalogue blames the scope, which is nearly always the cause", () => {
		assert.throws(() => findPipeline({ pipelines: [], broken: [] }, "build"), /none were loaded.*scope/s);
	});

	test("an unknown name lists what there is", () => {
		const catalogue = loadPipelinesFromDir(tmpDir({ "build.md": GOOD }));
		assert.throws(() => findPipeline(catalogue, "ship"), /Unknown pipeline "ship"\. Loaded: build/);
	});
});
