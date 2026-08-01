/**
 * `/pipelines` and `/run`, with everything they touch injected.
 *
 * Both exist because of a real confusion: a pipeline of one repository was
 * invisible from another, and nothing could be asked. So what is tested here is
 * mostly what the user is *told* - that a broken file is listed rather than
 * hidden, that an empty catalogue explains itself, and that a typo stops before
 * anything is spawned.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { CommandCtx } from "../extension/build.ts";
import {
	listPipelines,
	pipelineAnswer,
	pipelineLines,
	PIPELINE_MESSAGE,
	runNamed,
	type PipelineDeps,
} from "../extension/pipeline-commands.ts";
import { parsePipeline } from "../src/pipeline.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";
import { testTheme } from "./fixtures/theme.ts";

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

function fakeCtx() {
	const notes: { message: string; type?: string }[] = [];
	const statuses: (string | undefined)[] = [];
	const widgets: (string[] | undefined)[] = [];
	let editorText = "";

	const ctx = {
		cwd: "/repo",
		hasUI: true,
		ui: {
			theme: testTheme(),
			async custom<T>(): Promise<T> {
				throw new Error("no card is asked for here");
			},
			async input() {
				return undefined;
			},
			notify: (message: string, type?: string) => void notes.push({ message, type }),
			setStatus: (_key: string, text: string | undefined) => void statuses.push(text),
			setWidget: (_key: string, lines: string[] | undefined) => void widgets.push(lines),
			async editor(_title: string, prefill?: string) {
				return prefill;
			},
			async confirm() {
				return true;
			},
			setEditorText: (text: string) => void (editorText = text),
		},
	} as unknown as CommandCtx;

	return { ctx, notes, statuses, widgets, said: () => notes.map((note) => note.message).join("\n"), editorText: () => editorText };
}

function deps(over: PipelineDeps = {}): PipelineDeps {
	return {
		loadAgents: () => agents,
		loadPipelines: () => ({ pipelines: [explore], broken: [] }),
		runDir: () => "/tmp/never-written",
		tickMs: 0,
		runPipeline: (async () => ({
			pipeline: "explore",
			steps: [{ id: "look", kind: "fanOut" as const, result: {} as never }],
			output: "what it found",
			usage: { wallMs: 1, busyMs: 1, turns: 3, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			ok: true,
		})) as never,
		...over,
	};
}

describe("pipelineLines", () => {
	test("names each pipeline and the shape of its run", () => {
		const lines = pipelineLines({ pipelines: [explore], broken: [] }, "/repo");
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /^explore\s+fanOut → reduce - Look around, then answer$/);
	});

	test("a broken file is listed with the good ones, not hidden behind them", () => {
		const lines = pipelineLines(
			{ pipelines: [explore], broken: [{ name: "build", filePath: ".pi/pipelines/build.md", error: 'needs a "name".' }] },
			"/repo",
		);
		assert.equal(lines.length, 2);
		assert.match(lines[1] ?? "", /build\s+BROKEN: needs a "name"\. \(\.pi\/pipelines\/build\.md\)/);
	});

	test("nothing loaded says where to put one, which is the actual question", () => {
		const lines = pipelineLines({ pipelines: [], broken: [] }, "/repo");
		assert.match(lines.join("\n"), /\/repo\/\.pi\/pipelines\//);
		assert.match(lines.join("\n"), /~\/\.pi\/agent\/pipelines\//);
		assert.match(lines.join("\n"), /built-in default/);
	});
});

describe("/pipelines", () => {
	test("says what is loaded", () => {
		const { ctx, said } = fakeCtx();
		listPipelines(ctx, deps());
		assert.match(said(), /explore/);
	});

	test("a broken file makes it a warning, not a quiet listing", () => {
		const { ctx, notes } = fakeCtx();
		listPipelines(ctx, deps({ loadPipelines: () => ({ pipelines: [], broken: [{ name: "build", filePath: "x.md", error: "no steps" }] }) }));
		assert.equal(notes[0]?.type, "warning");
	});
});

describe("/run", () => {
	test("runs the named pipeline on the rest of the line", async () => {
		const { ctx, said } = fakeCtx();
		let input: string | undefined;

		const done = await runNamed("explore what does this repository do", ctx, deps({
			runPipeline: (async (options: { input: string }) => {
				input = options.input;
				return { pipeline: "explore", steps: [], output: "the answer", usage: { turns: 2 }, ok: true };
			}) as never,
		}));

		assert.equal(input, "what does this repository do");
		assert.equal(done?.ok, true);
		assert.match(said(), /explore: 0 step\(s\)/);
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
				runPipeline: (async (options: { input: string; model?: string }) => {
					order.push("run");
					seen = options.model;
					return { pipeline: "explore", steps: [], output: "x", usage: { turns: 1 }, ok: true };
				}) as never,
			}),
		);

		assert.deepEqual(order, ["check:local/qwen", "run"], "a typo costs a second, not a run");
		assert.equal(seen, "local/qwen");
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
				runPipeline: (async () => ((ran = true), {})) as never,
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
			runPipeline: (async () => ({ pipeline: "explore", steps: [], output: "the answer", usage: {}, ok: true })) as never,
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
			runPipeline: (async () => ({ pipeline: "explore", steps: [], output: "", usage: {}, ok: false, error: "boom" })) as never,
		}));

		assert.deepEqual(sent, [], "a failure is reported, never handed to the model as a finding");
	});

	test("no name says how to find one instead of guessing", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		await runNamed("", ctx, deps({ runPipeline: (async () => ((ran = true), {})) as never }));

		assert.equal(ran, false);
		assert.match(said(), /\/pipelines lists them/);
	});

	test("a name with nothing after it is refused: an empty request costs real tokens", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		await runNamed("explore", ctx, deps({ runPipeline: (async () => ((ran = true), {})) as never }));

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
				runPipeline: (async () => ((ran = true), {})) as never,
			}),
		);

		assert.equal(ran, false);
		assert.match(said(), /run: \.pi\/pipelines\/explore\.md does not parse: no steps/);
	});

	test("an unknown name stops before anything is spawned", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		await runNamed("ghost do something", ctx, deps({ runPipeline: (async () => ((ran = true), {})) as never }));

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
			runPipeline: (async () => ((ran = true), {})) as never,
		}));

		assert.equal(ran, false);
		assert.match(said(), /Unknown agent "nobody"/);
	});

	test("a failing run says where what ran was kept", async () => {
		const { ctx, said } = fakeCtx();
		await runNamed("explore x", ctx, deps({
			runPipeline: (async () => ({ pipeline: "explore", steps: [], output: "", usage: {}, ok: false, error: "step \"look\" failed" })) as never,
		}));

		assert.match(said(), /step "look" failed/);
		assert.match(said(), /\/tmp\/never-written/);
	});

	test("the widget goes when the run ends, thrown or not", async () => {
		const { ctx, widgets, statuses } = fakeCtx();
		await assert.rejects(() =>
			runNamed("explore x", ctx, deps({ runPipeline: (async () => { throw new Error("boom"); }) as never })),
		);

		assert.equal(widgets.at(-1), undefined, "no dead row of dots above the prompt");
		assert.equal(statuses.at(-1), undefined, "and no stale footer for the rest of the session");
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
