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
import type { BuildDeps, CommandCtx } from "../extension/build.ts";
import { listPipelines, pipelineLines, runNamed } from "../extension/pipeline-commands.ts";
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

function deps(over: BuildDeps = {}): BuildDeps {
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
		const { ctx, editorText, said } = fakeCtx();
		let input: string | undefined;

		const done = await runNamed("explore what does this repository do", ctx, deps({
			runPipeline: (async (options: { input: string }) => {
				input = options.input;
				return { pipeline: "explore", steps: [], output: "the answer", usage: { turns: 2 }, ok: true };
			}) as never,
		}));

		assert.equal(input, "what does this repository do");
		assert.equal(done?.ok, true);
		assert.equal(editorText(), "the answer", "the answer is long: sending it on stays the user's decision");
		assert.match(said(), /explore: 0 step\(s\)/);
	});

	test("no name says how to find one instead of guessing", async () => {
		const { ctx, said } = fakeCtx();
		let ran = false;
		await runNamed("", ctx, deps({ runPipeline: (async () => ((ran = true), {})) as never }));

		assert.equal(ran, false);
		assert.match(said(), /\/pipelines lists them/);
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
		const { ctx, said, editorText } = fakeCtx();
		await runNamed("explore x", ctx, deps({
			runPipeline: (async () => ({ pipeline: "explore", steps: [], output: "", usage: {}, ok: false, error: "step \"look\" failed" })) as never,
		}));

		assert.match(said(), /step "look" failed/);
		assert.match(said(), /\/tmp\/never-written/);
		assert.equal(editorText(), "", "a failure is not an answer to hand to the model");
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
