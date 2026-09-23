/**
 * The flows the package ships: each one checks against the shipped agents, is
 * reachable where pi looks for a repository's flows, ships in the tarball, and
 * walks the way its file says, on scripted turns. `build` and the attended
 * build have their own file.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { shippedCatalogue } from "../scripts/flow-docs.ts";
import { checkFlow, dryRunFlow, type DryRun } from "../src/flow/index.ts";
import { ROOT, shipped, visited } from "./fixtures/flow.ts";

/** A dry run's visits, as `path ok`. */
function paths(run: DryRun): string[] {
	return visited(run).map((entry) => `${entry.path} ${entry.ok}`);
}

const QUESTION = { header: "Store", question: "Where should the cache live?", options: [{ label: "In memory" }, { label: "On disk" }] };

describe("the shipped flows", () => {
	test("each one checks against the shipped agents", () => {
		const catalogue = shippedCatalogue(ROOT);
		assert.deepEqual(catalogue.flows.map((file) => file.name), ["build-attended", "build", "explore", "interview", "split"]);
		for (const { name } of catalogue.flows) {
			const checked = checkFlow(name, catalogue);
			assert.ok(checked.ok, `${name}: ${JSON.stringify(!checked.ok && checked.faults)}`);
		}
	});

	test("they are reachable at pi's project location, and the tarball carries them", () => {
		assert.deepEqual(readdirSync(join(ROOT, ".pi", "flows")), readdirSync(join(ROOT, "flows")));
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] };
		// The loaders find `agents/` and `flows/` inside the package: dropping one
		// from `files` breaks every installed user while the repository still has it.
		for (const needed of ["src", "extension", "agents", "flows"]) {
			assert.ok(manifest.files.includes(needed), `package.json "files" must list ${needed}`);
		}
	});
});

describe("explore", () => {
	const explore = shipped("explore");

	test("three scouts, then one answer from the three reports", async () => {
		const run = await dryRunFlow(explore, "how is a run resumed?", { "look/find": "src/flow/run/resume.ts:40", answer: "From its journal." });
		assert.deepEqual(run.ok && "output" in run && run.output, "From its journal.");
		assert.deepEqual(paths(run), ["look[1]/find true", "look[2]/find true", "look[3]/find true", "look true", "answer true"]);
	});

	test("a scout that fails reaches the answer as a failed report, not as a failed run", async () => {
		const run = await dryRunFlow(explore, "q", { "look/find": "found", "look[2]/find": { fail: "provider" }, answer: "a" });
		assert.ok(run.ok, JSON.stringify(run));
		const look = visited(run).find((entry) => entry.path === "look");
		assert.deepEqual((look?.output as { ok: boolean }[]).map((item) => item.ok), [true, false, true]);
	});
});

describe("split", () => {
	const split = shipped("split");

	test("each task goes to the worker the plan names, then one answer", async () => {
		const tasks = [{ worker: "scout", task: "find the journal" }, { worker: "reviewer", task: "judge its torn-line rule" }];
		const run = await dryRunFlow(split, "q", { plan: { tasks }, "work/act": "report", answer: "a" });
		assert.ok(run.ok, JSON.stringify(run));
		assert.deepEqual(visited(run).map((entry) => `${entry.path} ${entry.agent ?? ""}`.trim()), ["plan planner", "work[1]/act scout", "work[2]/act reviewer", "work", "answer synthesiser"]);
	});

	test("a plan past four tasks fails before any worker runs", async () => {
		const tasks = Array.from({ length: 5 }, (_, index) => ({ worker: "scout", task: `t${index}` }));
		const run = await dryRunFlow(split, "q", { plan: { tasks } });
		assert.deepEqual(!run.ok && "error" in run && [run.error.kind, run.path], ["too-many", "work"]);
		assert.deepEqual(paths(run), ["plan true", "work false"]);
	});
});

describe("interview", () => {
	const interview = shipped("interview");

	test("asks until the interviewer has no question left, then writes the brief", async () => {
		const run = await dryRunFlow(interview, "add a cache", {
			"interview/ask_next": [{ question: QUESTION }, { question: QUESTION }, {}],
			"interview/gate/ask": [{ answered: true, answer: "In memory" }, { answered: true, answer: "Both", custom: true }],
			brief: "Cache results in memory and on disk.",
		});
		assert.deepEqual(run.ok && "output" in run && run.output, "Cache results in memory and on disk.");
		assert.deepEqual(paths(run), [
			"interview#1/ask_next true",
			"interview#1/gate/ask true",
			"interview#1/gate true",
			"interview#2/ask_next true",
			"interview#2/gate/ask true",
			"interview#2/gate true",
			"interview#3/ask_next true",
			"interview#3/gate true",
			"interview true",
			"brief true",
		]);
		assert.equal(visited(run).find((entry) => entry.path === "interview")?.converged, true);
	});

	test("that's enough ends the questions, and the brief is written from what was answered", async () => {
		const run = await dryRunFlow(interview, "add a cache", { "interview/ask_next": { question: QUESTION }, "interview/gate/ask": { answered: false }, brief: "b" });
		assert.ok(run.ok);
		assert.deepEqual(paths(run), ["interview#1/ask_next true", "interview#1/gate/ask true", "interview#1/gate true", "interview true", "brief true"]);
	});

	test("six answered questions end the loop not converged, and the brief is still written", async () => {
		const run = await dryRunFlow(interview, "add a cache", { "interview/ask_next": { question: QUESTION }, "interview/gate/ask": { answered: true, answer: "On disk" }, brief: "b" });
		assert.deepEqual(run.ok && "output" in run && run.output, "b");
		const loop = visited(run).find((entry) => entry.path === "interview");
		assert.deepEqual([loop?.ok, loop?.converged, visited(run).filter((entry) => entry.path.endsWith("/ask")).length], [true, false, 6]);
	});
});
