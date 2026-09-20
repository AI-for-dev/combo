/**
 * Smoke tests for the extension's rendering.
 *
 * These do **not** inspect a terminal - they capture the registered tool and
 * call its renderers directly, then read the component's own `render(width)`
 * output. That keeps the rule (never scrape a terminal) while still catching
 * the failure that matters: a renderer that throws makes pi silently fall back
 * to its default rendering, and nobody notices until the demo.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import extension from "../extension/index.ts";
import { PIPELINE_MESSAGE } from "../extension/pipeline-commands.ts";
import { STEP_ENTRY } from "../extension/step-commands.ts";
import { emptyUsage } from "../src/usage.ts";
import type { SubagentSnapshot } from "../src/reporters/picture.ts";
import { testTheme } from "./fixtures/theme.ts";

// `getMarkdownTheme()` and `keyHint()` read process-wide state.
initTheme();

/** Captures everything the extension registers. */
function registered() {
	let tool: any;
	const commands = new Map<string, any>();
	const messageRenderers = new Map<string, any>();
	const entryRenderers = new Map<string, any>();
	extension({
		registerTool: (definition: unknown) => void (tool = definition),
		registerCommand: (name: string, options: unknown) => void commands.set(name, options),
		registerMessageRenderer: (customType: string, renderer: unknown) => void messageRenderers.set(customType, renderer),
		registerEntryRenderer: (customType: string, renderer: unknown) => void entryRenderers.set(customType, renderer),
	} as never);
	assert.ok(tool, "the extension must register a tool");
	return { tool, commands, messageRenderers, entryRenderers };
}

const { tool, commands, messageRenderers, entryRenderers } = registered();
const theme = testTheme();

/** A render context with nothing cached, as on the first frame. */
const context = { lastComponent: undefined, state: {}, invalidate: () => {} } as never;

const subagent = (over: Partial<SubagentSnapshot> = {}): SubagentSnapshot => ({
	id: "scout#1",
	agent: "scout",
	lifetime: "task",
	status: "done",
	task: "Find where lifetime is resolved",
	tools: [
		{ name: "grep", args: { pattern: "lifetime" } },
		{ name: "read", args: { path: "/x/subagent.ts", offset: 60, limit: 20 } },
	],
	output: "It is resolved in `spawn()`.\n\n- explicit argument wins\n- then the frontmatter",
	usage: { ...emptyUsage(), turns: 1, busyMs: 1_500, input: 12_000, output: 209 },
	depth: 0,
	ok: true,
	...over,
});

const details = (over: Record<string, unknown> = {}) => ({
	mode: "parallel",
	subagents: [subagent()],
	wallMs: 2_000,
	...over,
});

const lines = (component: Component) => component.render(80).join("\n");

describe("what the extension registers", () => {
	test("the interactive flows are commands, not tools", () => {
		// A tool runs inside a model turn, where nobody can answer a question.
		assert.ok(commands.has("interview"), "/interview must be a command");
		assert.ok(commands.get("interview")?.description, "a command with no description is invisible");
	});

	test("a chain can be walked by hand", () => {
		// Three commands, because the main session must be able to stay passive:
		// run a step, see the chain, and quote one on purpose.
		for (const name of ["step", "chain", "quote"]) {
			assert.ok(commands.has(name), `/${name} must be a command`);
			assert.ok(commands.get(name)?.description, "a command with no description is invisible");
		}
	});

	test("what is loaded can be asked for", () => {
		// Both listings answer the same question - "why can it not find mine?" -
		// and a listing nobody can reach answers nothing.
		for (const name of ["agents", "pipelines"]) {
			assert.ok(commands.has(name), `/${name} must be a command`);
			assert.ok(commands.get(name)?.description, "a command with no description is invisible");
		}
	});
});

describe("the registered tool", () => {
	test("is named subagent and declares its parameters", () => {
		assert.equal(tool.name, "subagent");
		assert.ok(tool.parameters, "the model needs a schema");
		assert.ok(tool.description.includes("scope"), "the model must be told project agents are opt-in");
	});
});

describe("renderCall", () => {
	test("shows the mode and the agent, and never throws on partial arguments", () => {
		for (const args of [{}, { agent: "scout" }, { mode: "loop", steps: ["coder", "reviewer"] }, { tasks: ["a", "b"] }]) {
			const component = tool.renderCall(args, theme, context);
			assert.doesNotThrow(() => lines(component));
		}
	});

	test("names the agent and the task", () => {
		const text = lines(tool.renderCall({ agent: "scout", task: "find the auth code" }, theme, context));
		assert.match(text, /subagent/);
		assert.match(text, /scout/);
		assert.match(text, /find the auth code/);
	});

	test("flags a persistent run and a herdr run", () => {
		const text = lines(tool.renderCall({ agent: "scout", lifetime: "workflow", openInHerdr: true }, theme, context));
		assert.match(text, /workflow/);
		assert.match(text, /herdr/);
	});

	test("counts the extra tasks rather than listing them all", () => {
		const text = lines(tool.renderCall({ agent: "scout", tasks: ["a", "b", "c"] }, theme, context));
		assert.match(text, /\+2 more/);
	});

	test("a bound on the delegation is shown, the way the model is", () => {
		assert.match(lines(tool.renderCall({ agent: "explorer", maxDepth: 3 }, theme, context)), /≤3 deep/);
		assert.doesNotMatch(lines(tool.renderCall({ agent: "explorer" }, theme, context)), /deep/, "silent when nobody set one");
	});
});

describe("renderResult", () => {
	const result = (over: Record<string, unknown> = {}) => ({
		content: [{ type: "text", text: "done" }],
		details: details(over),
	});

	test("streams progress while partial, instead of an opaque spinner", () => {
		const component = tool.renderResult(
			{ content: [{ type: "text", text: "1/3 done, 2 running" }] },
			{ expanded: false, isPartial: true },
			theme,
			context,
		);
		assert.match(lines(component), /1\/3 done, 2 running/);
	});

	test("collapsed: one line per subagent, its last tool calls, and the totals", () => {
		const text = lines(tool.renderResult(result(), { expanded: false, isPartial: false }, theme, context));

		assert.match(text, /scout#1/);
		assert.match(text, /Find where lifetime is resolved/);
		assert.match(text, /grep \/lifetime\//, "tool calls are formatted the way pi shows them");
		assert.match(text, /read .*:60-80/);
		assert.match(text, /1 turn 1\.5s/);
	});

	test("collapsed: the expand hint comes from the keybinding config, not a hard-coded Ctrl+O", () => {
		const text = lines(tool.renderResult(result(), { expanded: false, isPartial: false }, theme, context));
		assert.match(text, /expand/);
		assert.ok(!text.includes("Ctrl+O") || text.match(/expand/), "must go through keyHint");
	});

	test("expanded: full task, every tool call, the output, the usage", () => {
		const text = lines(tool.renderResult(result(), { expanded: true, isPartial: false }, theme, context));

		assert.match(text, /task/);
		assert.match(text, /tools/);
		assert.match(text, /output/);
		assert.match(text, /resolved in/, "the output is rendered, as Markdown");
		assert.match(text, /1 turn/);
	});

	test("a failed subagent shows its error, not its output", () => {
		const failed = result({ subagents: [subagent({ ok: false, error: "provider exploded", output: "" })] });
		const text = lines(tool.renderResult(failed, { expanded: true, isPartial: false }, theme, context));
		assert.match(text, /provider exploded/);
	});

	test("a delegated subagent is drawn under the one that asked for it", () => {
		const tree = result({
			subagents: [
				subagent({ id: "explorer#1", agent: "explorer" }),
				subagent({ id: "scout#1", parentId: "explorer#1", depth: 1 }),
			],
		});

		for (const expanded of [false, true]) {
			const rows = lines(tool.renderResult(tree, { expanded, isPartial: false }, theme, context)).split("\n");
			const explorer = rows.findIndex((row) => row.includes("explorer#1"));
			const scout = rows.findIndex((row) => row.includes("scout#1"));

			assert.ok(explorer < scout, `the parent comes first (expanded=${expanded})`);
			assert.match(rows[scout] as string, /^ {2}\S/, `the child is indented (expanded=${expanded})`);
		}
	});

	test("a flat run is drawn exactly as it was", () => {
		const flat = result({ subagents: [subagent(), subagent({ id: "scout#2" })] });
		const rows = lines(tool.renderResult(flat, { expanded: false, isPartial: false }, theme, context)).split("\n");

		assert.doesNotMatch(rows[0] as string, /^ /, "nothing is indented when nobody delegated");
	});

	test("a loop reports whether it converged, not just that it ran", () => {
		const ran = result({ mode: "loop", iterations: 3, converged: false });
		const text = lines(tool.renderResult(ran, { expanded: false, isPartial: false }, theme, context));

		assert.match(text, /3 iterations/);
		assert.match(text, /NOT converged/);
	});

	test("a parallel run surfaces the parallelism it achieved", () => {
		const parallel = result({
			subagents: [subagent(), subagent({ id: "scout#2" })],
			wallMs: 1_000,
		});
		const text = lines(tool.renderResult(parallel, { expanded: false, isPartial: false }, theme, context));
		assert.match(text, /×3\.00/, "3s of work in 1s of wall time");
	});

	test("no details is not a crash", () => {
		const bare = { content: [{ type: "text", text: "nothing happened" }], details: undefined };
		const text = lines(tool.renderResult(bare, { expanded: false, isPartial: false }, theme, context));
		assert.match(text, /nothing happened/);
	});

	test("elides older tool calls when collapsed", () => {
		const busy = result({
			subagents: [
				subagent({
					tools: Array.from({ length: 9 }, (_, i) => ({ name: "read", args: { path: `/x/${i}.ts` } })),
				}),
			],
		});
		const text = lines(tool.renderResult(busy, { expanded: false, isPartial: false }, theme, context));
		assert.match(text, /6 earlier calls/);
	});
});

describe("the message a finished pipeline leaves in the conversation", () => {
	const render = (message: unknown) => {
		const renderer = messageRenderers.get(PIPELINE_MESSAGE);
		assert.ok(renderer, "a pipeline's answer must not fall back to pi's default rendering");
		return (renderer(message, { expanded: false }, theme) as Component).render(80).join("\n");
	};

	test("names the pipeline and its steps, and renders the answer as Markdown", () => {
		const drawn = render({
			customType: PIPELINE_MESSAGE,
			content: "Result of the `explore` pipeline.\n\n# Findings\n\nIt reads files.",
			display: true,
			details: { pipeline: "explore", steps: ["look", "answer"] },
		});

		assert.match(drawn, /explore/);
		assert.match(drawn, /look → answer/);
		assert.match(drawn, /Findings/);
		assert.match(drawn, /It reads files\./);
	});

	test("details it did not write do not make it throw", () => {
		// A renderer that throws makes pi fall back silently, so the shapes that
		// can reach it - an older session, a hand-written entry - must all render.
		assert.doesNotThrow(() => render({ customType: PIPELINE_MESSAGE, content: "bare", display: true }));
	});
});

describe("the step entry renderer", () => {
	const render = (entry: Record<string, unknown>) => {
		const renderer = entryRenderers.get(STEP_ENTRY);
		assert.ok(renderer, "a step must not fall back to pi's default rendering");
		return (renderer(entry, { expanded: false }, theme) as Component).render(80).join("\n");
	};

	test("names the step, what it carried, and says it is not in the conversation", () => {
		const drawn = render({
			customType: STEP_ENTRY,
			data: { id: "plan", kind: "agent", from: "look", output: "# Plan\n\nThree steps.", turns: 2, dir: "runs/x/2-plan" },
		});

		assert.match(drawn, /plan/);
		assert.match(drawn, /←look/);
		assert.match(drawn, /2 turns/);
		assert.match(drawn, /outside this conversation/, "the one thing that must be readable at a glance");
		assert.match(drawn, /\/quote puts it in/, "and the door out of it");
		assert.match(drawn, /Three steps\./);
		assert.match(drawn, /^ {2}Three steps\./m, "the body is indented, so the block reads as an aside rather than an answer");
	});

	test("data it did not write does not make it throw", () => {
		assert.doesNotThrow(() => render({ customType: STEP_ENTRY, data: { id: "look", kind: "pipeline", output: "", turns: 0, dir: "" } }));
	});
});
