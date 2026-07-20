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
import { findPipeline, loadPipelinesFromDir } from "../src/pipeline-load.ts";
import { checkPipelineAgents } from "../src/workflows/pipeline-run.ts";

const scratch: string[] = [];

function tmpDir(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-pipelines-"));
	scratch.push(dir);
	for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
	return dir;
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
		const found = loadPipelinesFromDir(path.join(os.tmpdir(), "pi-subagent-does-not-exist"));
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

	test("they are reachable at pi's project location", () => {
		const linked = loadPipelinesFromDir(path.join(root, ".pi", "pipelines"));
		assert.deepEqual(
			linked.pipelines.map((one) => one.name).sort(),
			loadPipelinesFromDir(path.join(root, "pipelines")).pipelines.map((one) => one.name).sort(),
		);
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
