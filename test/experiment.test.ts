/**
 * The experiment matrix, on a real temporary directory.
 *
 * pi stays fake - the cells run a combinator over `fakeSpawn` - but the
 * directories and the two report files are genuine: the layout is what a human
 * opens afterwards, and asserting it against a mocked filesystem would prove
 * nothing about it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { experiment, type ExperimentCell } from "../src/experiment.ts";
import { experimentTable } from "../src/experiment-report.ts";
import { chain } from "../src/workflows/chain.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const coder = testAgent("coder");
const scratch: string[] = [];

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-experiment-"));
	scratch.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The cell body every test shares: one chain, spreading the cell's options. */
const runChain = async (cell: ExperimentCell) => {
	const result = await chain({ ...cell.options, steps: [coder], input: "x" });
	return { ok: result.ok, converged: result.output.includes("done") };
};

describe("experiment", () => {
	test("builds the matrix model-major, and puts each cell on its own model", async () => {
		const fake = fakeSpawn();
		const report = await experiment({
			models: ["a/one", "b/two"],
			repetitions: 3,
			runsDir: tmpDir(),
			spawn: fake.spawn,
			run: runChain,
		});

		assert.deepEqual(
			report.runs.map((one) => `${one.model}#${one.repetition}`),
			["a/one#1", "a/one#2", "a/one#3", "b/two#1", "b/two#2", "b/two#3"],
		);
		assert.deepEqual(
			fake.spawned.map((one) => one.options.model),
			["a/one", "a/one", "a/one", "b/two", "b/two", "b/two"],
		);
	});

	test("repetitions default to 1", async () => {
		const report = await experiment({
			models: ["a/one", "b/two"],
			runsDir: tmpDir(),
			spawn: fakeSpawn().spawn,
			run: runChain,
		});

		assert.equal(report.runs.length, 2);
		assert.equal(report.repetitions, 1);
	});

	test("rejects an empty model list, and a repetition count below 1", async () => {
		await assert.rejects(() => experiment({ models: [], run: runChain }), /`models` is empty/);
		await assert.rejects(
			() => experiment({ models: ["a/one"], repetitions: 0, run: runChain }),
			/at least 1/,
		);
	});

	describe("on disk", () => {
		test("one directory per model and repetition, each with its usage.json", async () => {
			const runsDir = tmpDir();
			const report = await experiment({
				models: ["a/one", "b/two"],
				repetitions: 2,
				runsDir,
				spawn: fakeSpawn().spawn,
				run: runChain,
			});

			assert.deepEqual(fs.readdirSync(report.dir).sort(), [
				"a-one",
				"b-two",
				"experiment.json",
				"experiment.md",
			]);
			assert.deepEqual(fs.readdirSync(path.join(report.dir, "a-one")).sort(), ["rep-1", "rep-2"]);
			assert.ok(fs.existsSync(path.join(report.dir, "a-one", "rep-1", "usage.json")));
			assert.deepEqual(
				report.runs.map((one) => one.dir),
				[
					path.join("a-one", "rep-1"),
					path.join("a-one", "rep-2"),
					path.join("b-two", "rep-1"),
					path.join("b-two", "rep-2"),
				],
				"relative to the experiment directory: a report survives a move",
			);
		});

		test("the subagents export into their own cell", async () => {
			const fake = fakeSpawn();
			const report = await experiment({
				models: ["a/one"],
				repetitions: 2,
				runsDir: tmpDir(),
				spawn: fake.spawn,
				run: runChain,
			});

			assert.deepEqual(
				fake.exported.map((one) => path.relative(report.dir, one.dir)),
				[path.join("a-one", "rep-1"), path.join("a-one", "rep-2")],
			);
		});

		test("experiment.json holds every cell, and experiment.md the table", async () => {
			const report = await experiment({
				models: ["a/one"],
				name: "a study",
				runsDir: tmpDir(),
				spawn: fakeSpawn().spawn,
				run: runChain,
			});

			const written = JSON.parse(fs.readFileSync(path.join(report.dir, "experiment.json"), "utf8"));
			assert.equal(written.name, "a study");
			assert.equal(written.runs.length, 1);
			assert.deepEqual(written.runs[0].outcome, { ok: true, converged: false }, "the outcome, verbatim");

			const markdown = fs.readFileSync(path.join(report.dir, "experiment.md"), "utf8");
			assert.match(markdown, /^# a study$/m);
			assert.match(markdown, /\| a\/one \|/);
		});
	});

	describe("failure", () => {
		test("a cell that reports a failure keeps its usage, and stays in the report", async () => {
			const fake = fakeSpawn(() => ({ ok: false, error: "model died", usage: { input: 120 } }));
			const report = await experiment({
				models: ["a/one"],
				runsDir: tmpDir(),
				spawn: fake.spawn,
				run: async (cell) => {
					const result = await chain({ ...cell.options, steps: [coder], input: "x" });
					return { ok: result.ok, error: result.error };
				},
			});

			assert.equal(report.runs.length, 1);
			assert.equal(report.runs[0]?.ok, false);
			assert.equal(report.runs[0]?.error, "model died");
			assert.equal(report.runs[0]?.usage.input, 120, "it spent tokens before it broke");
			assert.equal(report.byModel[0]?.failed, 1);
		});

		test("a callback that throws is a failed cell, not a crashed experiment", async () => {
			const fake = fakeSpawn(() => ({ usage: { input: 40 } }));
			const report = await experiment({
				models: ["a/one", "b/two"],
				runsDir: tmpDir(),
				spawn: fake.spawn,
				run: async (cell) => {
					await chain({ ...cell.options, steps: [coder], input: "x" });
					if (cell.model === "a/one") throw new Error("verifier exploded");
					return { ok: true };
				},
			});

			assert.equal(report.runs[0]?.ok, false);
			assert.equal(report.runs[0]?.error, "verifier exploded");
			assert.equal(report.runs[0]?.usage.input, 40, "the work it did before throwing is measured");
			assert.equal(report.runs[1]?.ok, true, "the other model still ran");
		});
	});

	describe("concurrency", () => {
		test("cells run one at a time by default: a race would measure the machine", async () => {
			const fake = fakeSpawn(() => ({ delayMs: 5 }));
			await experiment({
				models: ["a/one", "b/two"],
				repetitions: 2,
				runsDir: tmpDir(),
				spawn: fake.spawn,
				run: runChain,
			});

			assert.equal(fake.maxConcurrent, 1);
		});

		test("concurrency bounds the cells in flight", async () => {
			const fake = fakeSpawn(() => ({ delayMs: 5 }));
			await experiment({
				models: ["a/one", "b/two"],
				repetitions: 2,
				concurrency: 2,
				runsDir: tmpDir(),
				spawn: fake.spawn,
				run: runChain,
			});

			assert.equal(fake.maxConcurrent, 2);
		});
	});

	describe("cancellation", () => {
		test("aborting stops the remaining cells and still writes the report", async () => {
			const controller = new AbortController();
			const fake = fakeSpawn();
			const report = await experiment({
				models: ["a/one", "b/two"],
				repetitions: 2,
				runsDir: tmpDir(),
				signal: controller.signal,
				spawn: fake.spawn,
				run: async (cell) => {
					const result = await chain({ ...cell.options, steps: [coder], input: "x" });
					if (cell.repetition === 2) controller.abort();
					return { ok: result.ok };
				},
			});

			assert.equal(report.runs.length, 2, "the second model was never launched");
			assert.equal(report.error, "aborted");
			assert.ok(fs.existsSync(path.join(report.dir, "experiment.json")), "a partial report is still written");
		});
	});

	describe("the table", () => {
		test("one row per model, with the outcome flags as columns", async () => {
			const fake = fakeSpawn((_task, agent) => ({ output: agent.name === "coder" ? "done" : "" }));
			const report = await experiment({
				models: ["a/one", "b/two"],
				repetitions: 2,
				runsDir: tmpDir(),
				spawn: fake.spawn,
				run: runChain,
			});

			const lines = experimentTable(report);
			assert.equal(lines.length, 4, "a header, a separator, and one row per model");
			assert.match(lines[0] as string, /\| model \| runs \| ok \| converged \|/);
			assert.match(lines[2] as string, /^\| a\/one \| 2 \| 2\/2 \| 2\/2 \|/);
		});

		test("a failed model is visible in its own row, never dropped", async () => {
			const fake = fakeSpawn((_task, agent) => ({ ok: agent.name === "coder" }));
			const report = await experiment({
				models: ["a/one"],
				repetitions: 2,
				runsDir: tmpDir(),
				spawn: fake.spawn,
				run: async (cell) => ({ ok: cell.repetition === 1, rounds: cell.repetition }),
			});

			assert.match(experimentTable(report)[2] as string, /^\| a\/one \| 2 \| 1\/2 \| 1×1 2×1 \|/);
			assert.match(
				fs.readFileSync(path.join(report.dir, "experiment.md"), "utf8"),
				/## Failures/,
				"and named under the table",
			);
		});

		test("sums are stored, means are only displayed", async () => {
			const fake = fakeSpawn(() => ({ usage: { input: 100, cost: 0.02 } }));
			const report = await experiment({
				models: ["a/one"],
				repetitions: 2,
				runsDir: tmpDir(),
				spawn: fake.spawn,
				run: runChain,
			});

			assert.equal(report.byModel[0]?.total.input, 200, "the summary carries the sum");
			assert.equal(report.byModel[0]?.total.cost, 0.04);
			assert.match(experimentTable(report)[2] as string, /↑200/);
			assert.match(experimentTable(report)[2] as string, /\| \$0\.0200 \|$/, "the mean is a display derivative");
		});
	});

	test("the caller's listener sees the events of every cell", async () => {
		const models: (string | undefined)[] = [];
		await experiment({
			models: ["a/one", "b/two"],
			runsDir: tmpDir(),
			spawn: fakeSpawn().spawn,
			onEvent: (event) => {
				if (event.type === "spawn") models.push(event.agent);
			},
			run: runChain,
		});

		assert.deepEqual(models, ["coder", "coder"]);
	});
});
