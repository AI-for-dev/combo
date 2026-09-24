/**
 * The shipped `build` and its attended form, walked on scripted turns: the
 * pairs, the check and the audit round by round, and what the person's
 * answers decide before anything is committed.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkRun, dryRunFlow, type Answers, type DryRun, type FlowPorts } from "../src/flow/index.ts";
import { gitPort } from "../src/git/index.ts";
import { bashCheck } from "../src/verify.ts";
import { ROOT, shipped, visited } from "./fixtures/flow.ts";

const PASSED = { passed: true, report: "all green" };

/** A build that goes through in one round, every key under `prefix`: the path of the call when it is one. */
function approved(prefix = ""): Answers {
	return {
		[`${prefix}locate`]: "src/store.ts:10",
		[`${prefix}plan`]: { subtasks: [{ text: "add the cache" }, { text: "test it" }] },
		[`${prefix}deliver/work/pair/code`]: "done",
		[`${prefix}deliver/work/pair/review`]: { approved: true },
		[`${prefix}deliver/tests`]: PASSED,
		[`${prefix}deliver/audit`]: { approved: true },
		[`${prefix}report`]: "Added the cache in src/store.ts, and its tests. Nothing is left.",
	};
}

/** The visits of `run` whose path ends with `suffix`, as `path ok`. */
function ended(run: DryRun, suffix: string): string[] {
	return visited(run)
		.filter((entry) => entry.path.endsWith(suffix))
		.map((entry) => `${entry.path} ${entry.ok}`);
}

/** The value a visit of `run` ended with. */
function outputAt(run: DryRun, path: string): unknown {
	return visited(run).find((entry) => entry.path === path)?.output;
}

describe("build", () => {
	const build = shipped("build");

	test("checks its own repository: the script its `check` names is there", async () => {
		const ports: FlowPorts = { check: bashCheck(), git: gitPort() };
		const run = await checkRun(build, { cwd: ROOT, ports, somebodyThere: false });
		assert.ok(run.ok, JSON.stringify(!run.ok && run.faults));
	});

	test("locates, plans, pairs on each subtask, checks and audits the whole in one round, then reports", async () => {
		const run = await dryRunFlow(build, "add a cache", approved());
		assert.ok(run.ok && "output" in run, JSON.stringify(run));
		assert.equal(run.output, "Added the cache in src/store.ts, and its tests. Nothing is left.");
		const { converged, stop, iterations } = outputAt(run, "deliver") as { converged: boolean; stop: string; iterations: number };
		assert.deepEqual([converged, stop, iterations], [true, "until", 1]);
		assert.deepEqual(
			visited(run).map((entry) => entry.path),
			[
				"locate",
				"plan",
				"deliver#1/work[1]/pair#1/code",
				"deliver#1/work[2]/pair#1/code",
				"deliver#1/work[1]/pair#1/review",
				"deliver#1/work[2]/pair#1/review",
				"deliver#1/work[1]/pair",
				"deliver#1/work[2]/pair",
				"deliver#1/work",
				"deliver#1/tests",
				"deliver#1/audit",
				"deliver",
				"report",
			],
		);
		assert.deepEqual(run.journal.filter((entry) => entry.type === "copy_landed").map((entry) => entry.path), ["deliver#1/work[1]", "deliver#1/work[2]"]);
	});

	test("a review that reaches its cap goes on to the audit, which sends the subtask round again", async () => {
		const again = { approved: false, remarks: "the empty key is still not handled" };
		const run = await dryRunFlow(build, "add a cache", {
			...approved(),
			"deliver#1/work[2]/pair#1/review": { approved: false, raised: ["the empty key is not handled"] },
			"deliver#1/work[2]/pair#2/review": again,
			"deliver#1/work[2]/pair#3/review": again,
			"deliver/audit": [{ approved: false, raised: ["test the empty key"] }, { approved: true, resolved: [{ id: "o1", how: "addressed" }] }],
		});
		assert.ok(run.ok, JSON.stringify(run));
		assert.deepEqual(ended(run, "/review"), [
			"deliver#1/work[1]/pair#1/review true",
			"deliver#1/work[2]/pair#1/review true",
			"deliver#1/work[2]/pair#2/review true",
			"deliver#1/work[2]/pair#3/review true",
			"deliver#2/work[1]/pair#1/review true",
		]);
		const capped = visited(run).find((entry) => entry.path === "deliver#1/work[2]/pair");
		assert.deepEqual([capped?.ok, capped?.converged], [true, false]);
		assert.deepEqual(outputAt(run, "deliver#1/work"), [
			{ item: { text: "add the cache" }, ok: true, output: outputAt(run, "deliver#1/work[1]/pair"), landed: true },
			{ item: { text: "test it" }, ok: true, output: capped?.output, landed: true },
		]);
	});

	test("a review or an audit that ends with no verdict is asked once more, and what it raises then is owed", async () => {
		const run = await dryRunFlow(build, "add a cache", {
			...approved(),
			"deliver#1/work[2]/pair#1/review": [{ fail: "schema" }, { approved: false, raised: ["the empty key is not handled"] }],
			"deliver#1/work[2]/pair#2/review": { approved: true, resolved: [{ id: "o1", how: "addressed" }] },
			"deliver/audit": [{ fail: "schema" }, { approved: true }],
		});
		assert.ok(run.ok, JSON.stringify(run));
		assert.deepEqual(ended(run, "/review"), ["deliver#1/work[1]/pair#1/review true", "deliver#1/work[2]/pair#1/review true", "deliver#1/work[2]/pair#2/review true"]);
		assert.deepEqual(ended(run, "/audit"), ["deliver#1/audit true"]);
		const owed = run.journal.flatMap((entry) => (entry.type === "obligation_raised" ? [entry.obligation.text] : []));
		const closed = run.journal.flatMap((entry) => (entry.type === "obligation_closed" ? [entry.id] : []));
		assert.deepEqual([owed, closed], [["the empty key is not handled"], ["o1"]], "the second attempt's remark went on the ledger, and was closed");
	});

	test("a locate, a plan or a report that fails is asked once more, and the build goes on", async () => {
		const run = await dryRunFlow(build, "add a cache", {
			...approved(),
			locate: [{ fail: "provider" }, "src/store.ts:10"],
			plan: [{ fail: "schema" }, { subtasks: [{ text: "add the cache" }, { text: "test it" }] }],
			report: [{ fail: "timeout" }, "Added the cache in src/store.ts, and its tests. Nothing is left."],
		});
		assert.ok(run.ok && "output" in run, JSON.stringify(run));
		assert.equal(run.output, "Added the cache in src/store.ts, and its tests. Nothing is left.");
		assert.deepEqual([...ended(run, "locate"), ...ended(run, "plan"), ...ended(run, "report")], ["locate true", "plan true", "report true"]);
	});

	test("an audit that is not approved carries what it raised into a second round, which converges", async () => {
		const run = await dryRunFlow(build, "add a cache", {
			...approved(),
			"deliver/tests": [{ passed: false, report: "1 failing" }, PASSED],
			"deliver/audit": [{ approved: false, raised: ["fix the failing test"] }, { approved: true, resolved: [{ id: "o1", how: "addressed" }] }],
		});
		assert.ok(run.ok, JSON.stringify(run));
		assert.deepEqual((outputAt(run, "deliver") as { iterations: number }).iterations, 2);
		const carried = run.journal.filter((entry) => entry.type === "carry").map((entry) => [entry.path, entry.value]);
		assert.deepEqual(carried, [
			["deliver#1", [{ text: "add the cache" }, { text: "test it" }]],
			["deliver#2", [{ id: "o1", text: "fix the failing test" }]],
		]);
		assert.deepEqual(ended(run, "/code"), ["deliver#1/work[1]/pair#1/code true", "deliver#1/work[2]/pair#1/code true", "deliver#2/work[1]/pair#1/code true"]);
	});

	test("gives up when the tests fail and the audit leaves nothing open to carry, and reports nothing", async () => {
		const run = await dryRunFlow(build, "add a cache", { ...approved(), "deliver/tests": { passed: false, report: "1 failing" }, "deliver/audit": { approved: false, remarks: "the tests fail" } });
		assert.deepEqual(!run.ok && "error" in run && [run.error.kind, run.path], ["unconverged", "deliver"]);
		assert.deepEqual(ended(run, "/audit"), ["deliver#1/audit true"]);
		assert.deepEqual(ended(run, "report"), []);
	});

	test("fails at its cap when every audit raises something new", async () => {
		const run = await dryRunFlow(build, "add a cache", { ...approved(), "deliver/audit": [{ approved: false, raised: ["one"] }, { approved: false, raised: ["two"] }] });
		assert.deepEqual(!run.ok && "error" in run && [run.error.kind, run.path], ["unconverged", "deliver"]);
		assert.deepEqual(ended(run, "/audit"), ["deliver#1/audit true", "deliver#2/audit true"]);
	});
});

describe("build-attended", () => {
	const attended = shipped("build-attended");
	const interviewed: Answers = {
		"spec/interview/ask_next": {},
		"spec/brief": "Cache results in memory.",
	};

	test("interviews, confirms, builds the specification, then commits it on the run's branch", async () => {
		const commit = { committed: true, sha: "abc123", branch: "combo/add-a-cache" };
		const run = await dryRunFlow(attended, "add a cache", { ...interviewed, go: { yes: true }, ...approved("gate/work/"), "gate/message": "Cache results in memory", "gate/commit": commit });
		assert.ok(run.ok && "output" in run, JSON.stringify(run));
		assert.deepEqual(run.output, { case: "1", output: commit });
		const top = visited(run).filter((entry) => !entry.path.startsWith("spec/") && !entry.path.startsWith("gate/work/"));
		assert.deepEqual(top.map((entry) => entry.path), ["spec", "go", "gate/work", "gate/message", "gate/commit", "gate"]);
		assert.equal(outputAt(run, "spec"), "Cache results in memory.");
	});

	test("a confirm answered no ends the run ok, with nothing built and nothing committed", async () => {
		const run = await dryRunFlow(attended, "add a cache", { ...interviewed, go: { yes: false } });
		assert.ok(run.ok && "output" in run, JSON.stringify(run));
		assert.deepEqual(run.output, { case: "default" });
		assert.deepEqual(
			visited(run).map((entry) => entry.path),
			["spec/interview#1/ask_next", "spec/interview#1/gate", "spec/interview", "spec/brief", "spec", "go", "gate"],
		);
		assert.ok(!run.journal.some((entry) => entry.type === "branch_opened"));
	});
});
