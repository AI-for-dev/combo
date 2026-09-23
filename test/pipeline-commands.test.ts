/**
 * `/run`, with everything it touches injected.
 *
 * What is tested here is mostly what the user is *told*: that a broken file is
 * named rather than reported as unknown, and that a typo stops before anything
 * is spawned.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	pipelineAnswer,
	PIPELINE_MESSAGE,
	runNamed,
} from "../extension/commands/pipeline.ts";
import { parsePipeline } from "../src/pipeline/pipeline.ts";
import type { PipelineDeps } from "../extension/deps.ts";
import { fakeCtx } from "./fixtures/command-ctx.ts";
import { baseDeps } from "./fixtures/command-deps.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";
import { pipelineRunResult } from "./fixtures/results.ts";
import { succeeded } from "../src/result.ts";

initTheme();

const agents = ["scout", "synthesiser", "coder"].map((name) => testAgent(name, { description: `${name} for tests` }));

const explore = parsePipeline(
	`---
name: explore
description: Look around, then answer
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

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
	return {
		...baseDeps(agents, [explore]),
		sendMessage: () => undefined,
		runPipeline: async () =>
			pipelineRunResult({
				steps: [{ id: "look", kind: "fanOut", result: succeeded("scout", "") }],
				output: "what it found",
				usage: { wallMs: 1, busyMs: 1, turns: 3 },
			}),
		...over,
	};
}

describe("/run", () => {
	test("runs the named pipeline on the rest of the line", async () => {
		const { ctx, said } = fakeCtx();
		let input: string | undefined;

		const done = await runNamed("explore what does this repository do", ctx, deps({
			runPipeline: async (options: { input: string }) => {
				input = options.input;
				return pipelineRunResult({ output: "the answer", usage: { turns: 2 } });
			},
		}));

		assert.equal(input, "what does this repository do");
		assert.equal(done?.ok, true);
		assert.match(said(), /explore: 0 steps/);
	});

	test("--model is checked first, then reaches the pipeline run", async () => {
		const { ctx } = fakeCtx();
		const order: string[] = [];
		let seen: string | undefined;

		await runNamed(
			"--model local/qwen explore what is here",
			ctx,
			deps({
				checkModel: async (pattern) => void order.push(`check:${pattern}`),
				runPipeline: async (options: { input: string; model?: string }) => {
					order.push("run");
					seen = options.model;
					return pipelineRunResult({ output: "x", usage: { turns: 1 } });
				},
			}),
		);

		assert.deepEqual(order, ["check:local/qwen", "run"], "a typo costs a second, not a run");
		assert.equal(seen, "local/qwen");
	});

	test("an unsaid --worktree reaches the run as unsaid, not as a no", async () => {
		// The delivery decides from the size of its own plan, and it can only do
		// that if the command did not answer for it.
		const { ctx } = fakeCtx();
		const seen: unknown[] = [];
		const run = async (options: { worktree?: boolean }) => {
			seen.push(options.worktree);
			return pipelineRunResult({ output: "x", usage: { turns: 1 } });
		};

		await runNamed("explore what is here", ctx, deps({ runPipeline: run }));
		await runNamed("--worktree explore what is here", ctx, deps({ runPipeline: run }));
		await runNamed("--worktree=false explore what is here", ctx, deps({ runPipeline: run }));

		assert.deepEqual(seen, [undefined, true, false]);
	});

	test("a model that does not resolve stops before anything is spawned", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		const done = await runNamed(
			"--model local/nope explore x",
			ctx,
			deps({
				checkModel: async () => {
					throw new Error('No model found for "local/nope"');
				},
				runPipeline: async () => ((ran = true), pipelineRunResult()),
			}),
		);

		assert.equal(done, undefined);
		assert.equal(ran, false);
		assert.match(said(), /No model found/);
	});

	test("the answer lands in the conversation, not in the prompt editor", async () => {
		const { ctx, editorText } = fakeCtx();
		const sent: { customType: string; content: string; display: boolean }[] = [];

		await runNamed("explore what does this do", ctx, deps({
			sendMessage: (message) => void sent.push(message),
			runPipeline: async () => pipelineRunResult({ output: "the answer" }),
		}));

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.customType, PIPELINE_MESSAGE);
		assert.equal(sent[0]?.display, true);
		assert.match(sent[0]?.content ?? "", /the answer/);
		assert.equal(editorText(), "", "an exploration is read and then asked about, not re-typed by the user");
	});

	test("a failing run leaves nothing in the conversation", async () => {
		const { ctx } = fakeCtx();
		const sent: unknown[] = [];

		await runNamed("explore x", ctx, deps({
			sendMessage: (message) => void sent.push(message),
			runPipeline: async () => pipelineRunResult({ ok: false, error: "boom" }),
		}));

		assert.deepEqual(sent, [], "a failure is reported, never handed to the model as a finding");
	});

	test("no name says how to find one instead of guessing", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		await runNamed("", ctx, deps({ runPipeline: async () => ((ran = true), pipelineRunResult()) }));

		assert.equal(ran, false);
		assert.match(said(), /say which pipeline/);
	});

	test("a name with nothing after it is refused: an empty request costs real tokens", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		await runNamed("explore", ctx, deps({ runPipeline: async () => ((ran = true), pipelineRunResult()) }));

		assert.equal(ran, false);
		assert.match(said(), /say what explore should work on/);
	});

	test("a broken file is named, rather than reported as an unknown pipeline", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		await runNamed(
			"explore x",
			ctx,
			deps({
				loadPipelines: () => ({ pipelines: [], broken: [{ name: "explore", filePath: ".pi/pipelines/explore.md", error: "no steps" }] }),
				runPipeline: async () => ((ran = true), pipelineRunResult()),
			}),
		);

		assert.equal(ran, false);
		assert.match(said(), /Pipeline "explore" \(\.pi\/pipelines\/explore\.md\) does not parse: no steps/);
	});

	test("an unknown name stops before anything is spawned", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		await runNamed("ghost do something", ctx, deps({ runPipeline: async () => ((ran = true), pipelineRunResult()) }));

		assert.equal(ran, false);
		assert.match(said(), /Unknown pipeline "ghost"/);
	});

	test("a pipeline naming an agent nobody has is refused, not started", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		const ghosts = parsePipeline(
			"---\nname: explore\nsteps:\n  - id: look\n    chain: nobody\n---\n\n## look\nGo.\n",
			"explore.md",
		);
		await runNamed("explore x", ctx, deps({
			loadPipelines: () => ({ pipelines: [ghosts], broken: [] }),
			runPipeline: async () => ((ran = true), pipelineRunResult()),
		}));

		assert.equal(ran, false);
		assert.match(said(), /Unknown agent "nobody"/);
	});

	test("a failing run says where what ran was kept", async () => {
		const { ctx, said } = fakeCtx();
		await runNamed("explore x", ctx, deps({
			runPipeline: async () => pipelineRunResult({ ok: false, error: "step \"look\" failed" }),
		}));

		assert.match(said(), /step "look" failed/);
		assert.match(said(), /\/tmp\/never-written/);
	});
});

describe("pipelineAnswer", () => {
	test("names the pipeline and what it was asked, because the model reads it as a user message", () => {
		const framed = pipelineAnswer("explore", "what does this do", "It does things.");
		assert.match(framed, /^Result of the `explore` pipeline, asked to: what does this do\.\n\n/);
		assert.match(framed, /It does things\.$/);
	});

	test("with no input it still says where the text came from", () => {
		assert.match(pipelineAnswer("explore", "   ", "Findings."), /^Result of the `explore` pipeline\.\n\nFindings\.$/);
	});
});
