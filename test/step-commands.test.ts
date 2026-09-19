/**
 * `/step`, `/chain` and `/quote`, with everything they touch injected.
 *
 * What is asserted is mostly the one property the three exist for: **what the
 * main session gets to read**. A step is drawn and not sent, the output waits
 * in the relay for whoever asks for it, and `/quote` is the only door into the
 * conversation. A regression there is invisible in a terminal - the report
 * looks the same either way - and changes what the session does next.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { PIPELINE_MESSAGE } from "../extension/pipeline-commands.ts";
import { chainLines, currentChain, forgetChain } from "../extension/relay.ts";
import { quoteStep, runStep, showChain, STEP_ENTRY, type StepDeps, type StepEntry } from "../extension/step-commands.ts";
import { parsePipeline } from "../src/pipeline.ts";
import { emptyUsage } from "../src/usage.ts";
import { fakeCtx } from "./fixtures/command-ctx.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

initTheme();

const agents = ["scout", "synthesiser", "planner", "coder", "reviewer", "explore"].map((name) =>
	testAgent(name, { description: `${name} for tests` }),
);

const explore = parsePipeline(
	`---
name: explore
steps:
  - id: look
    fanOut: scout
    tasks: [a, b]
  - id: answer
    reduce: synthesiser
---

## look
Look.

## answer
Answer.
`,
	".pi/pipelines/explore.md",
);

// A real directory: `liveRun` writes a `usage.json` per step, and a test that
// pointed it at a path it never cleans up litters the machine it ran on.
const runs = mkdtempSync(join(tmpdir(), "combo-chain-"));
after(() => rmSync(runs, { recursive: true, force: true }));

/** The asks each double received, so the dataflow can be read back out. */
function deps(over: StepDeps = {}) {
	const pipelineInputs: string[] = [];
	const agentAsks: { agent: string; task: string; model?: string }[] = [];
	const entries: StepEntry[] = [];
	const sent: { content: string; details?: unknown }[] = [];

	const base: StepDeps = {
		loadAgents: () => agents,
		loadPipelines: () => ({ pipelines: [explore], broken: [] }),
		runDir: () => runs,
		tickMs: 0,
		appendEntry: (_customType, data) => void entries.push(data),
		sendMessage: (message) => void sent.push({ content: message.content, details: message.details }),
		runPipeline: (async (options: { input: string }) => {
			pipelineInputs.push(options.input);
			return {
				pipeline: "explore",
				steps: [],
				output: "three files, and how they are tested",
				usage: { ...emptyUsage(), turns: 3 },
				ok: true,
			};
		}) as never,
		run: (async (agent: { name: string }, task: string, options: { model?: string }) => {
			agentAsks.push({ agent: agent.name, task, model: options.model });
			return { agent: agent.name, output: `${agent.name} answered`, messages: [], usage: { ...emptyUsage(), turns: 1 }, ok: true };
		}) as never,
		...over,
	};

	return { deps: base, pipelineInputs, agentAsks, entries, sent };
}

beforeEach(forgetChain);

describe("/step", () => {
	test("runs the named pipeline and leaves the answer out of this conversation", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, entries, sent, pipelineInputs } = deps();

		const step = await runStep("explore where usage is measured", ctx, injected);

		assert.equal(step?.kind, "pipeline");
		assert.deepEqual(pipelineInputs, ["where usage is measured"]);
		assert.deepEqual(sent, [], "the main session must stay passive until /quote");
		assert.equal(entries[0]?.output, "three files, and how they are tested");
		assert.equal(entries[0]?.id, "explore");
	});

	test("a lone agent is a step too, and that is the point of the command", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, agentAsks } = deps();

		const step = await runStep("planner three steps at most", ctx, injected);

		assert.equal(step?.kind, "agent");
		assert.deepEqual(agentAsks.map((ask) => ask.agent), ["planner"]);
		assert.equal(agentAsks[0]?.task, "three steps at most");
	});

	test("the next step is handed the previous one's output, in a pipeline's own sections", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, agentAsks } = deps();

		await runStep("explore where usage is measured", ctx, injected);
		await runStep("planner three steps at most", ctx, injected);

		const task = agentAsks[0]?.task ?? "";
		assert.match(task, /## Request\n\nthree steps at most/);
		assert.match(task, /## Output of step `explore`\n\nthree files, and how they are tested/);
	});

	test("--from none starts a step from scratch", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, agentAsks } = deps();

		await runStep("explore where usage is measured", ctx, injected);
		await runStep("--from none coder write a slugify helper", ctx, injected);

		assert.equal(agentAsks[0]?.task, "write a slugify helper");
	});

	test("--from reaches back to any step of the chain", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, agentAsks } = deps();

		await runStep("planner the plan", ctx, injected);
		await runStep("coder the code", ctx, injected);
		await runStep("--from planner reviewer does the code match the plan", ctx, injected);

		assert.match(agentAsks[2]?.task ?? "", /## Output of step `planner`/);
	});

	test("--from a step that is not there stops before anything is spawned", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, agentAsks } = deps();

		await runStep("planner the plan", ctx, injected);
		const step = await runStep("--from plan coder go", ctx, injected);

		assert.equal(step, undefined);
		assert.equal(agentAsks.length, 1, "nothing ran");
		assert.match(said(), /no step called `plan`/);
	});

	test("a failing step leaves the chain exactly where it was", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, entries } = deps({
			run: (async (agent: { name: string }) =>
				agent.name === "coder"
					? { agent: agent.name, output: "", messages: [], usage: emptyUsage(), ok: false, error: "context exhausted" }
					: { agent: agent.name, output: "the plan", messages: [], usage: emptyUsage(), ok: true }) as never,
		});

		await runStep("planner the plan", ctx, injected);
		const failedStep = await runStep("coder go", ctx, injected);

		assert.equal(failedStep, undefined);
		assert.deepEqual(currentChain()?.steps.map((step) => step.id), ["planner"], "a failure carries nothing forward");
		assert.equal(entries.length, 1, "and is not drawn as material either");
		assert.match(said(), /coder failed: context exhausted/);
		assert.match(said(), /what ran is in/, "the transcripts are still worth reading");
	});

	test("a name that is neither a pipeline nor an agent says so once", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, agentAsks } = deps();

		const step = await runStep("plannr go", ctx, injected);

		assert.equal(step, undefined);
		assert.equal(agentAsks.length, 0);
		assert.match(said(), /neither a pipeline nor an agent/);
		assert.match(said(), /\/pipelines and \/agents/, "both listings, because either could be the answer");
	});

	test("a name held by both runs the pipeline, and says --agent runs the other", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, pipelineInputs, agentAsks } = deps();

		await runStep("explore what is here", ctx, injected);
		assert.equal(pipelineInputs.length, 1);
		assert.match(said(), /both a pipeline and an agent/);

		await runStep("--from none --agent explore what is here", ctx, injected);
		assert.deepEqual(agentAsks.map((ask) => ask.agent), ["explore"]);
	});

	test("--model is checked first, then reaches the step", async () => {
		const { ctx } = fakeCtx();
		const order: string[] = [];
		const { deps: injected, agentAsks } = deps({ checkModel: async (pattern) => void order.push(`check:${pattern}`) });

		await runStep("--model local/qwen planner the plan", ctx, injected);

		assert.deepEqual(order, ["check:local/qwen"]);
		assert.equal(agentAsks[0]?.model, "local/qwen");
	});

	test("a model that does not resolve stops before anything is spawned", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, agentAsks } = deps({
			checkModel: async () => {
				throw new Error('No model found for "local/nope"');
			},
		});

		await runStep("--model local/nope planner the plan", ctx, injected);

		assert.equal(agentAsks.length, 0);
		assert.match(said(), /No model found/);
	});

	test("nothing to do and nothing carried is refused; carrying something is not", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, agentAsks } = deps();

		assert.equal(await runStep("reviewer", ctx, injected), undefined);
		assert.match(said(), /say what reviewer should do/);

		await runStep("coder write a slugify helper", ctx, injected);
		const review = await runStep("reviewer", ctx, injected);

		assert.equal(review?.id, "reviewer", "with an output in hand, `review that` is the ordinary case");
		assert.match(agentAsks[1]?.task ?? "", /## Output of step `coder`/);
	});

	test("one folder for the chain, one subfolder per step, in the order they ran", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected } = deps();

		await runStep("planner the plan", ctx, injected);
		await runStep("coder the code", ctx, injected);

		assert.deepEqual(currentChain()?.steps.map((step) => step.dir), [join(runs, "1-planner"), join(runs, "2-coder")]);
	});
});

describe("/chain", () => {
	test("lists the steps walked so far", async () => {
		const { ctx, said } = fakeCtx();
		await runStep("planner the plan", ctx, deps().deps);

		showChain("", ctx);
		assert.match(said(), /1\. planner/);
	});

	test("reset drops it, so the next step starts a new folder", async () => {
		const { ctx } = fakeCtx();
		await runStep("planner the plan", ctx, deps().deps);

		showChain("reset", ctx);
		assert.equal(currentChain(), undefined);
		assert.match(chainLines(currentChain()).join("\n"), /No chain yet/);
	});

	test("a word it does not know says what it does know", () => {
		const { ctx, notes } = fakeCtx();
		showChain("clear", ctx);
		assert.equal(notes[0]?.type, "warning");
		assert.match(notes[0]?.message ?? "", /reset/);
	});
});

describe("/quote", () => {
	test("puts one step into the conversation, attributed", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, sent } = deps();
		await runStep("planner three steps at most", ctx, injected);

		quoteStep("", ctx, injected);

		assert.equal(sent.length, 1);
		assert.match(sent[0]?.content ?? "", /^Result of the `planner` step of the chain, asked to: three steps at most\./);
		assert.match(sent[0]?.content ?? "", /planner answered/);
	});

	test("names the chain it came from: the quote itself says which step", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, sent } = deps();
		await runStep("planner the plan", ctx, injected);
		await runStep("coder the code", ctx, injected);

		quoteStep("planner", ctx, injected);

		assert.deepEqual(sent[0]?.details, { pipeline: "chain", steps: ["planner", "coder"], exportDir: join(runs, "1-planner") });
		assert.match(sent[0]?.content ?? "", /^Result of the `planner` step/);
	});

	test("nothing has run: it says how to start, rather than sending an empty quote", () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, sent } = deps();

		quoteStep("", ctx, injected);

		assert.deepEqual(sent, []);
		assert.match(said(), /nothing has run yet/);
	});

	test("the entry a step leaves is the one pi renders, and never the shared message", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, entries, sent } = deps();

		await runStep("planner the plan", ctx, injected);

		assert.equal(entries.length, 1, "drawn once");
		assert.deepEqual(sent, [], "and in context never, until asked");
		assert.equal(STEP_ENTRY, "chain-step");
		assert.notEqual(STEP_ENTRY, PIPELINE_MESSAGE, "an entry is invisible to the model; a message is not");
	});
});
