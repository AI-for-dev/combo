import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { Chat } from "../pane/chat.ts";
import { createScreen } from "../pane/screen.ts";
import { emptyUsage } from "../src/usage.ts";

/** A terminal nobody looks at: the components render to strings regardless. */
function headless(): Terminal {
	return {
		start() {},
		stop() {},
		async drainInput() {},
		write() {},
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
	};
}

/** What a person would read, without the colours. */
const plain = (lines: string[]) => lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd()).join("\n");

initTheme();

describe("pane chat", () => {
	test("a replayed transcript reads as pi draws it: the task, the answer, each tool with its result", () => {
		const chat = new Chat(new TUI(headless()), "/repo");
		chat.replay({ role: "user", content: "Where is the wall time measured?" });
		chat.replay({
			role: "assistant",
			content: [
				{ type: "text", text: "Looking." },
				{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "wallMs", path: "src" } },
			],
			stopReason: "toolUse",
		});
		chat.replay({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "src/subagent.ts:12: wallMs" }], isError: false });
		chat.replay({ role: "assistant", content: [{ type: "text", text: "In `src/subagent.ts`, **line 12**." }], stopReason: "stop" });

		const text = plain(chat.container.render(80));
		assert.match(text, /Where is the wall time measured\?/);
		assert.match(text, /Looking\./);
		assert.match(text, /grep/);
		assert.match(text, /wallMs/);
		assert.match(text, /line 12/, "Markdown is rendered, not shown");
		assert.ok(!text.includes("**"), "Markdown is rendered, not shown");
	});

	test("a live turn: streamed text grows in place, a tool box fills in when its result lands", () => {
		const chat = new Chat(new TUI(headless()), "/repo");
		chat.live({ type: "message_start", message: { role: "user", content: "Read a.ts" } });
		chat.live({ type: "message_start", message: { role: "assistant", content: [] } });
		chat.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Read" }] } });
		chat.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Reading a.ts" }] } });
		assert.match(plain(chat.container.render(80)), /Reading a\.ts/);
		assert.equal(plain(chat.container.render(80)).match(/Read/g)?.length, 2, "one user line, one assistant line, drawn once each");

		chat.live({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Reading a.ts" }, { type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "x", path: "a.ts" } }],
			},
		});
		chat.live({ type: "message_end", message: { role: "assistant", content: [], stopReason: "toolUse" } });
		chat.live({ type: "tool_execution_start", toolCallId: "c1", toolName: "grep", args: { pattern: "x", path: "a.ts" } });
		const before = plain(chat.container.render(80));
		assert.match(before, /grep \/x\/ in a\.ts/);
		assert.ok(!before.includes("a.ts:1:"), "no result yet");

		chat.live({ type: "tool_execution_end", toolCallId: "c1", toolName: "grep", result: { content: [{ type: "text", text: "a.ts:1: const x" }] }, isError: false });
		assert.match(plain(chat.container.render(80)), /a\.ts:1: const x/);
	});

	test("a turn that died marks its open tool boxes with pi's own words", () => {
		const chat = new Chat(new TUI(headless()), "/repo");
		chat.replay({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 100" } }],
			stopReason: "aborted",
		});
		assert.match(plain(chat.container.render(80)), /Operation aborted/);
	});

	test("a tool pi cannot name is drawn under a question mark, not under nothing", () => {
		const chat = new Chat(new TUI(headless()), "/repo");
		chat.live({ type: "tool_execution_start", toolCallId: "c1", toolName: "", args: { path: "a.ts" } });
		assert.match(plain(chat.container.render(80)), /\?/);
	});
});

describe("pane screen", () => {
	function screenWith(actions: Partial<Parameters<typeof createScreen>[3]> = {}) {
		const ui = new TUI(headless());
		const said: string[] = [];
		const screen = createScreen(ui, "scout#1", "/repo", {
			steer: (text) => said.push(`steer ${text}`),
			abort: () => said.push("abort"),
			leave: () => said.push("leave"),
			...actions,
		});
		return { ui, screen, said, text: () => plain(ui.render(80)) };
	}

	test("the footer says who this is, what it runs on, what it spent and what the keys do", () => {
		const { screen, text } = screenWith();
		screen.handle({ type: "attached", id: "scout#1", agent: "scout", model: "provider/model", cwd: "/repo", pi: "" });
		screen.handle({ type: "status", id: "scout#1", status: "working", task: "look" });
		screen.handle({ type: "usage", id: "scout#1", usage: { ...emptyUsage(), input: 12_000, output: 209, turns: 1, busyMs: 12_400 } });
		assert.match(text(), /scout#1 · provider\/model · .*↑12k ↓209/);
		assert.match(text(), /working · enter steers · esc stops/);
	});

	test("a refusal is shown where the person typed, and a closed subagent stays on screen", () => {
		const { screen, text } = screenWith();
		screen.handle({ type: "refused", reason: "between tasks - it can only be steered while it works" });
		assert.match(text(), /between tasks - it can only be steered while it works/);

		screen.handle({
			type: "close",
			id: "scout#1",
			result: { agent: "scout", output: "", messages: [], ok: true, usage: { ...emptyUsage(), turns: 2 } },
		});
		assert.match(text(), /done · esc to close/);
	});

	test("enter steers, esc stops, ctrl+c leaves - and once done, esc leaves too", () => {
		const { ui, screen, said } = screenWith();
		// What the terminal would hand the TUI, byte for byte.
		const press = (data: string) => (ui as unknown as { handleInput(data: string): void }).handleInput(data);
		const editor = (ui as unknown as { children: { onSubmit?: (text: string) => void }[] }).children.find((c) => c.onSubmit);
		editor?.onSubmit?.("look at test/ first");
		assert.deepEqual(said, ["steer look at test/ first"]);

		press("\u001b");
		assert.equal(said.at(-1), "abort");
		press("\u0003");
		assert.equal(said.at(-1), "leave");

		screen.handle({ type: "close", id: "scout#1", result: { agent: "scout", output: "", messages: [], ok: true, usage: emptyUsage() } });
		press("\u001b");
		assert.equal(said.at(-1), "leave", "nothing left to stop");
	});
});
