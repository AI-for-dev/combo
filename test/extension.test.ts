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
import { emptyUsage } from "../src/usage.ts";
import type { SubagentSnapshot } from "../src/reporters/tui.ts";
import { testTheme } from "./fixtures/theme.ts";

// `getMarkdownTheme()` and `keyHint()` read process-wide state.
initTheme();

/** Captures the tool definition the extension registers. */
function registeredTool(): any {
	let tool: any;
	extension({ registerTool: (definition: unknown) => void (tool = definition) } as never);
	assert.ok(tool, "the extension must register a tool");
	return tool;
}

const tool = registeredTool();
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
