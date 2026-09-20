/**
 * The whole pane: the chat, a footer, a line for what was refused, and the
 * prompt. What the keyboard does is decided here, and only here.
 *
 * `enter` steers, `esc` stops, `ctrl+c` leaves without touching the subagent.
 * A pane whose subagent is done keeps the transcript on screen and says so in
 * the footer, so the last thing it said is not lost with the window.
 */

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { SubagentStatus } from "../src/events.ts";
import type { MirrorOut } from "../src/mirror.ts";
import { formatUsage, type Usage } from "../src/usage.ts";
import { Chat, type Live, type Message } from "./chat.ts";

/** What the screen does with what the person typed. */
export type ScreenActions = {
	/** A line submitted while the subagent works. */
	steer(text: string): void;
	/** `esc`: stop the subagent. */
	abort(): void;
	/** `ctrl+c`: leave the pane. */
	leave(): void;
};

/** The pane's screen, fed by the mirror's lines. */
export type Screen = {
	/** One line from the mirror. */
	handle(line: MirrorOut): void;
	/** The line to the mirror went, with a reason or not. */
	disconnected(reason?: string): void;
};

const DIM = (text: string) => `\u001b[2m${text}\u001b[22m`;

/**
 * One line of the wire, by its `type`.
 *
 * `MirrorOut` carries pi's own events too, typed as loosely as pi emits them,
 * so `line.type` alone cannot narrow it: this does, for the lines that are ours.
 */
type Line<T extends string> = Extract<MirrorOut, { type: T }>;

/** Builds the screen into `ui`. Nothing is drawn until `ui.start()`. */
export function createScreen(ui: TUI, id: string, cwd: string, actions: ScreenActions): Screen {
	const chat = new Chat(ui, cwd);
	const notice = new Text("", 1, 0);
	// Two lines, because a pane is narrow: who and what it spent, then what it
	// is doing and what the keys do.
	const footer = new Text("", 1, 0);
	const hints = new Text("", 1, 0);
	// pi's own editor theme is not exported; its border is muted, and so is this.
	const editor = new Editor(ui, { borderColor: DIM, selectList: getSelectListTheme() }, { paddingX: 1 });

	let model: string | undefined;
	let status: SubagentStatus = "idle";
	let usage: Usage | undefined;
	let over = false;

	const draw = () => {
		footer.setText(DIM([id, model, usage && formatUsage(usage)].filter(Boolean).join(" · ")));
		hints.setText(DIM(over ? "done · esc to close" : status === "working" ? "working · enter steers · esc stops" : `${status} · esc stops`));
		ui.requestRender();
	};

	editor.onSubmit = (text) => {
		const word = text.trim();
		editor.setText("");
		if (!word) return;
		editor.addToHistory(word);
		notice.setText("");
		if (over) {
			notice.setText(DIM("done - nobody is listening"));
			return;
		}
		actions.steer(word);
	};

	ui.addInputListener((data) => {
		if (matchesKey(data, Key.ctrl("c"))) {
			actions.leave();
			return { consume: true };
		}
		if (matchesKey(data, Key.escape)) {
			if (over) actions.leave();
			else actions.abort();
			return { consume: true };
		}
		return undefined;
	});

	ui.addChild(chat.container);
	ui.addChild(new Spacer(1));
	ui.addChild(notice);
	ui.addChild(editor);
	ui.addChild(footer);
	ui.addChild(hints);
	ui.setFocus(editor);
	draw();

	return {
		handle(line) {
			switch (line.type) {
				case "attached":
					model = (line as Line<"attached">).model;
					draw();
					break;
				case "message":
					chat.replay((line as Line<"message">).message as Message);
					break;
				case "refused":
					notice.setText(DIM((line as Line<"refused">).reason));
					ui.requestRender();
					break;
				case "status":
					status = (line as Line<"status">).status;
					draw();
					break;
				case "usage":
					usage = (line as Line<"usage">).usage;
					draw();
					break;
				case "close":
					over = true;
					usage = (line as Line<"close">).result.usage;
					draw();
					break;
				case "error":
					over = true;
					notice.setText(DIM((line as Line<"error">).message));
					draw();
					break;
				case "steer":
					break;
				default:
					chat.live(line as Live);
			}
		},
		disconnected(reason) {
			over = true;
			if (reason) notice.setText(DIM(reason));
			draw();
		},
	};
}
