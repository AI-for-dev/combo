/**
 * Saving and reloading a build, on real files.
 *
 * The whole point of this state is that it survives a process, so it is written
 * and read back through the filesystem here. What it must not carry is the
 * conversation: a resumed build re-reads the code, it does not replay messages.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	BUILD_STATE_FILE,
	BUILD_STATE_VERSION,
	findResumableBuild,
	fromBuildState,
	loadBuildState,
	saveBuildState,
	toBuildState,
	type BuildProgress,
} from "../src/resume.ts";
import { emptyUsage } from "../src/usage.ts";
import type { PairResult } from "../src/workflows/pair.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

const coder = testAgent("coder");
const scribe = testAgent("scribe");
const agents = [coder, scribe];

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-resume-"));
	scratch.push(dir);
	return dir;
}

const task = (agent: string, input: string, approved: boolean): PairResult => ({
	agent,
	input,
	output: `${agent} did ${input}`,
	messages: [{ role: "user", content: "a whole conversation" } as never],
	usage: { ...emptyUsage(), turns: 2, input: 1_000 },
	ok: true,
	steps: [{ agent, output: "turn", messages: [], usage: emptyUsage(), ok: true }],
	rounds: 2,
	approved,
});

const progress = (over: Partial<BuildProgress> = {}): BuildProgress => ({
	plan: [
		{ agent: coder, task: "write it" },
		{ agent: scribe, task: "document it" },
	],
	tasks: [task("coder", "write it", true)],
	audits: [],
	done: false,
	...over,
});

const about = { request: "add a cache", brief: "THE BRIEF", cwd: "/repo" };

describe("the saved state", () => {
	test("round-trips through a file", () => {
		const dir = tmpDir();
		const file = saveBuildState(dir, toBuildState(progress(), about));

		assert.equal(file, path.join(dir, BUILD_STATE_FILE));
		const reloaded = loadBuildState(file as string);
		assert.equal(reloaded?.brief, "THE BRIEF");
		assert.equal(reloaded?.plan.length, 2);
		assert.equal(reloaded?.tasks[0]?.task, "write it", "a task that cannot say what it was asked cannot be resumed");
	});

	test("carries no conversation: a resumed build re-reads the code", () => {
		const state = toBuildState(progress(), about);
		const text = JSON.stringify(state);

		assert.ok(!text.includes("a whole conversation"), "messages have no business surviving the process");
		assert.ok(text.length < 4_000, "small enough to write after every step");
	});

	test("agents are saved by name and resolved again", () => {
		const state = toBuildState(progress(), about);
		assert.deepEqual(
			state.plan.map((step) => step.agent),
			["coder", "scribe"],
		);

		const back = fromBuildState(state, agents);
		assert.equal(back?.plan[0]?.agent, coder, "the same object the caller uses everywhere else");
		assert.equal(back?.tasks[0]?.approved, true);
	});

	test("a plan naming an agent that no longer exists is refused, not half-applied", () => {
		const state = toBuildState(progress(), about);
		assert.equal(fromBuildState(state, [coder]), undefined, "dropping a step would silently drop work");
	});

	test("a state from another version is ignored rather than guessed at", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, BUILD_STATE_FILE), JSON.stringify({ version: BUILD_STATE_VERSION + 1 }));

		assert.equal(loadBuildState(path.join(dir, BUILD_STATE_FILE)), undefined);
	});

	test("an unreadable or missing file is undefined, never a throw", () => {
		const dir = tmpDir();
		assert.equal(loadBuildState(path.join(dir, "nope.json")), undefined);
		fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
		assert.equal(loadBuildState(path.join(dir, "broken.json")), undefined);
	});

	test("saving into an impossible place fails quietly: losing a safety net is not a failure", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, "file"), "");
		assert.equal(saveBuildState(path.join(dir, "file", "nested"), toBuildState(progress(), about)), undefined);
	});
});

describe("findResumableBuild", () => {
	/** Two runs, the newer one unfinished. */
	function runs(): string {
		const base = tmpDir();
		for (const [stamp, done] of [
			["2026-07-19_09-00-00", true],
			["2026-07-19_11-00-00", false],
		] as const) {
			const dir = path.join(base, stamp);
			saveBuildState(dir, toBuildState(progress({ done }), about));
		}
		return base;
	}

	test("finds the most recent unfinished build", () => {
		const found = findResumableBuild(runs());
		assert.match(found?.dir ?? "", /11-00-00$/, "directories sort by timestamp, so no stat call is needed");
	});

	test("a finished build is not offered: carrying on means carrying on something that stopped", () => {
		const base = tmpDir();
		saveBuildState(path.join(base, "2026-07-19_09-00-00"), toBuildState(progress({ done: true }), about));

		assert.equal(findResumableBuild(base), undefined);
	});

	test("a build from another directory is not offered here", () => {
		const base = runs();
		assert.ok(findResumableBuild(base, "/repo"), "same cwd, offered");
		assert.equal(findResumableBuild(base, "/elsewhere"), undefined);
	});

	test("no runs directory at all is undefined, not a crash", () => {
		assert.equal(findResumableBuild(path.join(tmpDir(), "nothing-here")), undefined);
	});
});
