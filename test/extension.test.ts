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
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import extension from "../extension/index.ts";
import { RESULT_MESSAGE } from "../extension/commands/answer.ts";
import { livePlan } from "../src/flow/index.ts";
import { checked } from "./fixtures/flow.ts";
import { sessionDoors, toolDeps, type PiApi } from "../extension/pi.ts";
import { STEP_ENTRY } from "../extension/relay.ts";
import { emptyUsage } from "../src/usage.ts";
import type { SubagentSnapshot } from "../src/reporters/picture.ts";
import { fakeCtx } from "./fixtures/command-ctx.ts";
import { testTheme } from "./fixtures/theme.ts";

// `getMarkdownTheme()` and `keyHint()` read process-wide state.
initTheme();

/**
 * Captures everything the extension registers.
 *
 * The fake is typed as the slice of pi's API the extension declares it uses,
 * so a method pi renames fails here at compile time rather than in a terminal.
 */
function registered() {
	let tool: any;
	const commands = new Map<string, Parameters<PiApi["registerCommand"]>[1]>();
	const messageRenderers = new Map<string, any>();
	const entryRenderers = new Map<string, any>();
	const sent: unknown[] = [];
	const appended: unknown[] = [];
	const pi: PiApi = {
		registerTool: (definition) => void (tool = definition),
		registerCommand: (name, options) => void commands.set(name, options),
		registerMessageRenderer: (customType, renderer) => void messageRenderers.set(customType, renderer),
		registerEntryRenderer: (customType, renderer) => void entryRenderers.set(customType, renderer),
		sendMessage: (message) => void sent.push(message),
		appendEntry: (customType, data) => void appended.push({ customType, data }),
	};
	extension(pi);
	assert.ok(tool, "the extension must register a tool");
	return { pi, tool, commands, messageRenderers, entryRenderers, sent, appended };
}

const { pi, tool, commands, messageRenderers, entryRenderers, appended } = registered();
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
		for (const name of ["agents", "flows"]) {
			assert.ok(commands.has(name), `/${name} must be a command`);
			assert.ok(commands.get(name)?.description, "a command with no description is invisible");
		}
		assert.ok(!commands.has("pipelines"), "/flows replaces /pipelines");
	});

	test("a flow runs through /run, and /build is gone", () => {
		assert.ok(commands.get("run")?.description, "/run must be a command");
		assert.ok(!commands.has("build"), "`/run build` starts the shipped build");
	});
});

describe("the registered tool", () => {
	test("is named subagent and declares its parameters", () => {
		assert.equal(tool.name, "subagent");
		assert.ok(tool.parameters, "the model needs a schema");
		assert.ok(tool.description.includes("scope"), "the model must be told project agents are opt-in");
	});

	test("runs one call at a time, so two flows never put up a card or a plan at once", () => {
		assert.equal(tool.executionMode, "sequential");
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

	test("names what the mode runs, whatever else the model passed beside it", () => {
		const loop = { steps: ["coder", "reviewer"], until: "LGTM", task: "t" };
		const header = (args: Record<string, unknown>) => (lines(tool.renderCall(args, theme, context)).replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0] ?? "").trim();
		assert.equal(header(loop), "subagent loop coder → reviewer");
		assert.equal(header({ ...loop, agent: "coder" }), header(loop));
		assert.equal(header({ mode: "chain", agent: "scout", steps: ["scout", "reviewer"] }), "subagent chain scout → reviewer");
		assert.equal(header({ agent: "router", candidates: ["scout", "coder"] }), "subagent route router");
		assert.equal(header({ candidates: ["scout", "coder"] }), "subagent route scout, coder");
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

	test("collapsed: a provider that reported no cost gets no `$0.0000` in the totals, and one that did gets its cost", () => {
		assert.doesNotMatch(lines(tool.renderResult(result(), { expanded: false, isPartial: false }, theme, context)), /\$/);
		const paid = result({ subagents: [subagent({ usage: { ...emptyUsage(), turns: 1, busyMs: 1_500, input: 12_000, output: 209, cost: 0.0412 } })] });
		assert.match(lines(tool.renderResult(paid, { expanded: false, isPartial: false }, theme, context)), /\$0\.0412/);
	});

	test("collapsed and expanded: a call pi refused is marked so, with pi's words", () => {
		const refused = result({ subagents: [subagent({ tools: [{ name: "write", args: { path: "notes.txt" }, error: "Tool write not found" }] })] });
		for (const expanded of [false, true]) {
			assert.match(lines(tool.renderResult(refused, { expanded, isPartial: false }, theme, context)).replace(/\x1b\[[0-9;]*m/g, ""), /✗ write notes\.txt · Tool write not found/);
		}
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

	test("says one elided call in the singular", () => {
		const four = result({ subagents: [subagent({ tools: Array.from({ length: 4 }, (_, i) => ({ name: "read", args: { path: `/x/${i}.ts` } })) })] });
		assert.match(lines(tool.renderResult(four, { expanded: false, isPartial: false }, theme, context)), /… 1 earlier call\b(?!s)/);
	});
});

describe("the message a finished run leaves in the conversation", () => {
	const render = (message: unknown) => {
		const renderer = messageRenderers.get(RESULT_MESSAGE);
		assert.ok(renderer, "a run's answer must not fall back to pi's default rendering");
		return (renderer(message, { expanded: false }, theme) as Component).render(80).join("\n");
	};

	test("names what ran and its steps, and renders the answer as Markdown", () => {
		const drawn = render({
			customType: RESULT_MESSAGE,
			content: "Result of the chain.\n\n# Findings\n\nIt reads files.",
			display: true,
			details: { name: "chain", steps: ["look", "answer"] },
		});

		assert.match(drawn, /chain/);
		assert.match(drawn, /look → answer/);
		assert.match(drawn, /Findings/);
		assert.match(drawn, /It reads files\./);
	});

	test("a flow's last frame is drawn under its answer, at the width pi draws in", () => {
		const flow = checked("  - id: look\n    agent: scout\n    reads: [input]", { look: "Look." });
		const drawn = render({ customType: RESULT_MESSAGE, content: "Result of the `f` flow.\n\nFound it.\n\nok · runs/x", display: true, details: { name: "f", runDir: "runs/x", live: livePlan(flow, [], []) } }).replace(/\x1b\[[0-9;]*m/g, "");

		assert.match(drawn, /Found it\./);
		assert.match(drawn, /○ f · 0 visits/);
		assert.match(drawn, /○ look · agent scout/);
		assert.ok(drawn.split("\n").every((line) => line.length <= 80), "a frame line wider than the terminal wraps back to column one");
	});

	test("details it did not write do not make it throw", () => {
		// A renderer that throws makes pi fall back silently, so the shapes that
		// can reach it - an older session, a hand-written entry - must all render.
		assert.doesNotThrow(() => render({ customType: RESULT_MESSAGE, content: "bare", display: true }));
		assert.doesNotThrow(() => render({ customType: RESULT_MESSAGE, content: "old", display: true, details: { pipeline: "explore", steps: ["look"] } }));
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

describe("where pi comes in", () => {
	test("a registered handler takes the context a test builds, with no cast in between", async () => {
		// pi hands the whole `ExtensionCommandContext`; the handler is written
		// against the slice, and the slice is what a test can build. The one cast
		// is here, at the door, standing in for the members pi has and we never
		// read.
		const { ctx, said } = fakeCtx();
		await commands.get("chain")?.handler("", ctx as never);
		assert.match(said(), /No chain yet/);
	});

	test("RPC mode is nobody there: it has dialogs, but no card can be drawn", async () => {
		const { ctx, said } = fakeCtx();
		ctx.mode = "rpc";
		await commands.get("interview")?.handler("add a cache", ctx as never);
		assert.match(said(), /interview: there is nobody to ask outside an interactive session/);
	});

	test("the tool body is handed pi's working directory, its UI, and the parent session", () => {
		const { ctx } = fakeCtx();
		const signal = new AbortController().signal;
		const onUpdate = () => {};
		const sessionManager = SessionManager.inMemory("/repo");

		const deps = toolDeps({ ...ctx, sessionManager }, signal, onUpdate);

		assert.equal(deps.cwd, "/repo");
		assert.equal(deps.ui, ctx.ui);
		assert.equal(deps.signal, signal);
		assert.equal(deps.onUpdate, onUpdate);
		assert.equal(deps.mainSession, sessionManager);
		assert.equal(deps.mode, "tui");
	});

	test("a pi that hands no session leaves the parent session out, rather than inventing one", () => {
		const { ctx } = fakeCtx();
		assert.equal(toolDeps(ctx, undefined, undefined).mainSession, undefined);
	});

	test("the two doors into the session are pi's own methods, bound", () => {
		const doors = sessionDoors(pi);
		doors.appendEntry(STEP_ENTRY, { id: "look", kind: "agent", output: "", turns: 0, dir: "" });
		assert.deepEqual(appended.at(-1), { customType: STEP_ENTRY, data: { id: "look", kind: "agent", output: "", turns: 0, dir: "" } });
	});
});
