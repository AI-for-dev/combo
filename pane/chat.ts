/**
 * The chat of a mirrored session, drawn with pi's own components.
 *
 * pi's interactive mode is fed by the same events this receives, and runs the
 * same switch: `message_start` opens an assistant message, each
 * `message_update` hands it the partial message, a tool call in it opens a
 * tool box, `tool_execution_end` fills the box in. History is drawn from the
 * transcript by role. So the pane looks like pi because it *is* pi's chat,
 * minus what belongs to a session it does not own.
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import { toolDefinition } from "./renderers.ts";

/** A transcript entry, read the way pi's chat reads it. */
export type Message = {
	role: string;
	content: unknown;
	toolCallId?: string;
	stopReason?: string;
	errorMessage?: string;
	isError?: boolean;
};

/** A pi session event, the fields the chat reads. Loose like `SessionEvent`. */
export type Live = {
	type: string;
	message?: Message;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	partialResult?: unknown;
};

type ToolCall = { type: "toolCall"; id: string; name: string; arguments: unknown };
type Assistant = Parameters<AssistantMessageComponent["updateContent"]>[0];

/** The chat: one container, fed by transcript entries and by live events. */
export class Chat {
	readonly container = new Container();
	readonly #ui: TUI;
	readonly #cwd: string;
	/** Tool boxes waiting for their result, by call id - pi's `pendingTools`. */
	readonly #pending = new Map<string, ToolExecutionComponent>();
	#streaming: AssistantMessageComponent | undefined;
	#empty = true;

	constructor(ui: TUI, cwd: string) {
		this.#ui = ui;
		this.#cwd = cwd;
	}

	/** One entry of the transcript as it stood when the pane attached. */
	replay(message: Message): void {
		switch (message.role) {
			case "user":
				this.#user(message);
				break;
			case "assistant": {
				this.#add(new AssistantMessageComponent(message as Assistant, false, getMarkdownTheme()));
				for (const call of toolCalls(message)) {
					const box = this.#box(call.name, call.id, call.arguments);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						box.updateResult(failure(message), false);
					} else {
						this.#pending.set(call.id, box);
					}
				}
				break;
			}
			case "toolResult": {
				const box = message.toolCallId ? this.#pending.get(message.toolCallId) : undefined;
				if (box && message.toolCallId) {
					box.updateResult(message as never, false);
					this.#pending.delete(message.toolCallId);
				}
				break;
			}
		}
	}

	/** One event of the turn in flight. */
	live(event: Live): void {
		switch (event.type) {
			case "message_start":
				if (event.message?.role === "user") this.#user(event.message);
				else if (event.message?.role === "assistant") {
					this.#streaming = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
					this.#add(this.#streaming);
					this.#streaming.updateContent(event.message as Assistant);
				}
				break;
			case "message_update":
				if (this.#streaming && event.message?.role === "assistant") {
					this.#streaming.updateContent(event.message as Assistant);
					for (const call of toolCalls(event.message)) {
						const box = this.#pending.get(call.id);
						if (box) box.updateArgs(call.arguments);
						else this.#pending.set(call.id, this.#box(call.name, call.id, call.arguments));
					}
				}
				break;
			case "message_end":
				if (this.#streaming && event.message?.role === "assistant") {
					this.#streaming.updateContent(event.message as Assistant);
					const failed = event.message.stopReason === "aborted" || event.message.stopReason === "error";
					for (const box of this.#pending.values()) {
						if (failed) box.updateResult(failure(event.message), false);
						else box.setArgsComplete();
					}
					if (failed) this.#pending.clear();
					this.#streaming = undefined;
				}
				break;
			case "tool_execution_start": {
				if (!event.toolCallId) break;
				let box = this.#pending.get(event.toolCallId);
				if (!box) {
					box = this.#box(event.toolName || "?", event.toolCallId, event.args);
					this.#pending.set(event.toolCallId, box);
				}
				box.markExecutionStarted();
				break;
			}
			case "tool_execution_update":
				if (event.toolCallId) {
					this.#pending.get(event.toolCallId)?.updateResult({ ...(event.partialResult as object), isError: false } as never, true);
				}
				break;
			case "tool_execution_end":
				if (event.toolCallId) {
					this.#pending.get(event.toolCallId)?.updateResult({ ...(event.result as object), isError: event.isError } as never, false);
					this.#pending.delete(event.toolCallId);
				}
				break;
			case "agent_end":
				this.#streaming = undefined;
				this.#pending.clear();
				break;
		}
		this.#ui.requestRender();
	}

	#user(message: Message) {
		const text = userText(message);
		if (!text) return;
		if (!this.#empty) this.container.addChild(new Spacer(1));
		this.#add(new UserMessageComponent(text, getMarkdownTheme()));
	}

	#box(name: string, id: string, args: unknown): ToolExecutionComponent {
		// A tool of ours has no definition here, and pi draws it with the generic
		// box - which is what a subagent tool should look like.
		const box = new ToolExecutionComponent(name, id, args, {}, toolDefinition(name, this.#cwd), this.#ui, this.#cwd);
		box.setExpanded(false);
		this.#add(box);
		return box;
	}

	#add(component: Container) {
		this.container.addChild(component);
		this.#empty = false;
	}
}

/** The text of a user message: pi stores either a string or blocks. */
function userText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => (part as { type?: string })?.type === "text")
		.map((part) => part.text)
		.join("");
}

function toolCalls(message: Message): ToolCall[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.filter((part): part is ToolCall => (part as { type?: string })?.type === "toolCall");
}

/** What a tool box shows when the turn around it died. pi's own words. */
function failure(message: Message) {
	const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
	return { content: [{ type: "text", text }], isError: true } as never;
}
