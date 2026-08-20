/**
 * Running a pipeline, with the combinators underneath fed by a fake `spawn`.
 *
 * What matters here is not that `chain` chains - that is `chain`'s own test -
 * but the three things only the runner can get wrong: the order it walks, what
 * one step hands the next, and the promise that a bad file costs **nothing**.
 * The last one is asserted the only way it can be: by counting spawns after a
 * failure, not by reading the error message.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parsePipeline } from "../src/pipeline.ts";
import { runPipeline, stepInput } from "../src/workflows/pipeline-run.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const agents = ["scout", "coder", "reviewer", "planner", "synthesiser", "router"].map((name) => testAgent(name));

/** Builds a pipeline file from its frontmatter and body, as a user would write it. */
function pipeline(frontmatter: string, body: string) {
	return parsePipeline(`---\n${frontmatter}\n---\n\n${body}\n`, "test.md");
}

describe("runPipeline", () => {
	test("walks the steps in order, feeding each one the previous output", async () => {
		const fake = fakeSpawn();
		const done = await runPipeline({
			pipeline: pipeline(
				"name: p\nsteps:\n  - id: find\n    chain: scout\n  - id: judge\n    chain: reviewer",
				"## find\nLocate it.\n\n## judge\nJudge it.",
			),
			agents,
			input: "the request",
			spawn: fake.spawn,
		});

		assert.equal(done.ok, true);
		assert.deepEqual(
			done.steps.map((step) => step.id),
			["find", "judge"],
		);
		// The first step sees its prose and the request; the second sees its prose,
		// the **same request**, and what the first produced.
		assert.equal(fake.asks[0]?.task, "Locate it.\n\n## Request\n\nthe request");
		assert.match(fake.asks[1]?.task ?? "", /^Judge it\.\n\n## Request\n\nthe request\n\n## Output of step `find`\n\nscout\(/);
	});

	test("a failing step stops the pipeline, and what ran is kept", async () => {
		const fake = fakeSpawn((_task, agent) => (agent.name === "scout" ? { ok: false, error: "boom" } : {}));
		const done = await runPipeline({
			pipeline: pipeline(
				"name: p\nsteps:\n  - id: find\n    chain: scout\n  - id: judge\n    chain: reviewer",
				"## find\nLocate it.\n\n## judge\nJudge it.",
			),
			agents,
			input: "x",
			spawn: fake.spawn,
		});

		assert.equal(done.ok, false);
		assert.match(done.error ?? "", /step "find" \(chain\) failed: boom/);
		assert.equal(done.steps.length, 1, "the second step never ran");
		assert.equal(fake.spawned.length, 1);
	});

	test("an unknown agent costs nothing: it throws before any spawn", async () => {
		const fake = fakeSpawn();
		await assert.rejects(
			() =>
				runPipeline({
					pipeline: pipeline(
						"name: p\nsteps:\n  - id: one\n    chain: scout\n  - id: two\n    chain: ghost",
						"## one\nGo.\n\n## two\nGo.",
					),
					agents,
					input: "x",
					spawn: fake.spawn,
				}),
			/Unknown agent "ghost"/,
		);
		assert.equal(fake.spawned.length, 0, "not one session was opened for a file that cannot run");
	});

	test("the request reaches every step, not only the first", async () => {
		const fake = fakeSpawn();
		await runPipeline({
			pipeline: pipeline(
				"name: p\nsteps:\n  - id: one\n    chain: scout\n  - id: two\n    chain: reviewer\n  - id: three\n    chain: coder",
				"## one\nA.\n\n## two\nB.\n\n## three\nC.",
			),
			agents,
			input: "what does this repository do",
			spawn: fake.spawn,
		});

		// The bug this pins down was found in a real run: a step that only ever
		// sees the previous output cannot tell what the run was for, and the last
		// agent answered "there is no question asked in the prompt".
		for (const ask of fake.asks) {
			assert.match(ask.task, /## Request\n\nwhat does this repository do/);
		}
	});

	test("reduce folds the branches of the step before it", async () => {
		const fake = fakeSpawn();
		const done = await runPipeline({
			pipeline: pipeline(
				"name: p\nsteps:\n  - id: explore\n    fanOut: scout\n    tasks: [a, b]\n  - id: sum\n    reduce: synthesiser",
				"## explore\nLook.\n\n## sum\nSynthesise.",
			),
			agents,
			input: "x",
			spawn: fake.spawn,
		});

		assert.equal(done.ok, true);
		assert.equal(done.steps[0]?.results?.length, 2);
		// The synthesiser was handed both branches, not just the last one.
		const synthesis = fake.asks.at(-1)?.task ?? "";
		assert.match(synthesis, /scout\(Look\.\n\na/);
		assert.match(synthesis, /scout\(Look\.\n\nb/);
	});

	test("reduce is handed the branches once, not twice", async () => {
		const fake = fakeSpawn();
		await runPipeline({
			pipeline: pipeline(
				"name: p\nsteps:\n  - id: explore\n    fanOut: scout\n    tasks: [a, b]\n  - id: sum\n    reduce: synthesiser",
				"## explore\nLook.\n\n## sum\nSynthesise.",
			),
			agents,
			input: "the question",
			spawn: fake.spawn,
		});

		// `reduce` formats the branches itself. Passing it the previous output as
		// well printed every report twice, and a real run said so: "duplicate
		// reports, verbatim duplicates".
		const synthesis = fake.asks.at(-1)?.task ?? "";
		assert.equal(synthesis.match(/scout\(Look\.\n\na/g)?.length, 1);
		assert.doesNotMatch(synthesis, /## Output of step/);
		assert.match(synthesis, /## Request\n\nthe question/, "and the question it is meant to answer is there");
	});

	test("a reduce with nothing to fold says so instead of spawning", async () => {
		const fake = fakeSpawn();
		const done = await runPipeline({
			pipeline: pipeline("name: p\nsteps:\n  - id: sum\n    reduce: synthesiser", "## sum\nSynthesise."),
			agents,
			input: "x",
			spawn: fake.spawn,
		});

		assert.equal(done.ok, false);
		assert.match(done.error ?? "", /nothing to fold/);
		assert.equal(fake.spawned.length, 0, "a synthesis of nothing is not worth a session");
	});

	test("a loop that never converges is a failure, not a silent hand-over", async () => {
		const fake = fakeSpawn();
		const done = await runPipeline({
			pipeline: pipeline(
				'name: p\nsteps:\n  - id: refine\n    loop: [coder, reviewer]\n    until: "LGTM"\n    maxIterations: 2\n  - id: after\n    chain: scout',
				"## refine\nRefine.\n\n## after\nNext.",
			),
			agents,
			input: "x",
			spawn: fake.spawn,
		});

		assert.equal(done.ok, false);
		assert.match(done.error ?? "", /never converged on "LGTM" in 2 iteration\(s\)/);
		assert.equal(done.steps.length, 1, "the next step is not handed unconverged work");
	});

	test("a step's own lifetime wins over the run's", async () => {
		const fake = fakeSpawn();
		await runPipeline({
			pipeline: pipeline(
				"name: p\nsteps:\n  - id: one\n    chain: [coder, reviewer, coder]\n    lifetime: workflow",
				"## one\nGo.",
			),
			agents,
			input: "x",
			lifetime: "task",
			spawn: fake.spawn,
		});

		assert.equal(fake.spawned.length, 2, "the step asked for workflow: coder is reused");
	});

	test("a combinator's own default survives a step and a run that set nothing", async () => {
		// The runner merges step overrides onto the run's options. Writing the key
		// unconditionally turns "nobody asked" into an explicit `undefined`, which
		// then beats the default the combinator sets for itself - `pair` keeps its
		// two agents talking to each other, and it must still do so from a file.
		let round = 0;
		const fake = fakeSpawn((_task, agent) => {
			if (agent.name !== "reviewer") return { output: "work" };
			round++;
			return { output: round >= 3 ? "LGTM" : `remark ${round}` };
		});

		await runPipeline({
			pipeline: pipeline("name: p\nsteps:\n  - id: one\n    pair: [coder, reviewer]\n    maxRounds: 3", "## one\nGo."),
			agents,
			input: "x",
			spawn: fake.spawn,
		});

		assert.equal(fake.spawned.length, 2, "pair defaults to workflow, and a pipeline must not undo that");
	});

	test("the caller's model beats the file's, and the file's is used when the caller passes none", async () => {
		const pinned = pipeline("name: p\nmodel: local/from-file\nsteps:\n  - id: one\n    chain: scout", "## one\nGo.");

		const swept = fakeSpawn();
		await runPipeline({ pipeline: pinned, agents, input: "x", model: "local/from-caller", spawn: swept.spawn });
		assert.equal(swept.spawned[0]?.options.model, "local/from-caller", "a pinned file must not survive a sweep");

		const alone = fakeSpawn();
		await runPipeline({ pipeline: pinned, agents, input: "x", spawn: alone.spawn });
		assert.equal(alone.spawned[0]?.options.model, "local/from-file");
	});

	test("cancellation stops it between steps", async () => {
		const controller = new AbortController();
		const fake = fakeSpawn(() => {
			controller.abort();
			return {};
		});
		const done = await runPipeline({
			pipeline: pipeline(
				"name: p\nsteps:\n  - id: one\n    chain: scout\n  - id: two\n    chain: reviewer",
				"## one\nGo.\n\n## two\nGo.",
			),
			agents,
			input: "x",
			signal: controller.signal,
			spawn: fake.spawn,
		});

		assert.equal(done.ok, false);
		assert.equal(done.error, "aborted");
		assert.equal(done.steps.length, 1);
	});

	test("usage is the sum of the steps, and wallMs the run itself", async () => {
		const fake = fakeSpawn(() => ({ usage: { input: 100, busyMs: 5 } }));
		const done = await runPipeline({
			pipeline: pipeline(
				"name: p\nsteps:\n  - id: one\n    chain: scout\n  - id: two\n    chain: reviewer",
				"## one\nGo.\n\n## two\nGo.",
			),
			agents,
			input: "x",
			spawn: fake.spawn,
		});

		assert.equal(done.usage.input, 200);
		assert.ok(done.usage.wallMs >= 0);
	});

	test("onStep reports as it goes, and a listener that throws is swallowed", async () => {
		const fake = fakeSpawn();
		const seen: string[] = [];
		const done = await runPipeline({
			pipeline: pipeline(
				"name: p\nsteps:\n  - id: one\n    chain: scout\n  - id: two\n    chain: reviewer",
				"## one\nGo.\n\n## two\nGo.",
			),
			agents,
			input: "x",
			spawn: fake.spawn,
			onStep: (step) => {
				seen.push(step.id);
				throw new Error("a reporting hook is an observer");
			},
		});

		assert.deepEqual(seen, ["one", "two"]);
		assert.equal(done.ok, true);
	});
});

describe("stepInput", () => {
	test("the prose, the request, then the previous step's output, each named", () => {
		assert.equal(
			stepInput("Do this.", "the request", { id: "look", output: "what it found" }),
			"Do this.\n\n## Request\n\nthe request\n\n## Output of step `look`\n\nwhat it found",
		);
	});

	test("a first step has no previous output, and gets no empty heading for one", () => {
		assert.equal(stepInput("Do this.", "the request"), "Do this.\n\n## Request\n\nthe request");
		assert.doesNotMatch(stepInput("Do this.", "the request"), /Output of step/);
	});

	test("an empty part is dropped rather than left as a heading with nothing under it", () => {
		assert.equal(stepInput("Do this.", "   "), "Do this.");
		assert.equal(stepInput("Do this.", "r", { id: "x", output: "  " }), "Do this.\n\n## Request\n\nr");
	});
});
