/**
 * The picture of a run: the event stream folded, once, into what every reader
 * wants to know - who is alive, under whom, doing what, at what cost.
 *
 * The TUI widget, the console, `usage.json`, an experiment's cell and the
 * tool's own result all read this. None of them folds the stream itself: a fix
 * to how the picture is built reaches every one of them, and a reader that
 * kept its own copy of a fact would be the copy that drifts.
 *
 * Nothing here draws. Formatting is `tui.ts`, and it takes a snapshot in;
 * putting a child under its parent is `tree.ts`.
 */

import type { EventListener, SubagentStatus } from "../events.ts";
import { emptyUsage, sumUsage, type Usage } from "../usage.ts";

/** A tool call as it happened, kept for the expanded view. */
export type ToolCall = {
	/** The tool pi ran, e.g. `read` or `bash`. */
	name: string;
	/** Its arguments, untouched: the expanded view formats them, we only keep them. */
	args: unknown;
};

/** Everything known about one subagent, at one instant. */
export type SubagentSnapshot = {
	/** The subagent, e.g. `scout#1`. Unique for the life of the process. */
	id: string;
	/** The agent it came from. Several subagents may share one agent. */
	agent: string;
	/** The lifetime it is running with - the row says whether it will remember. */
	lifetime: string;
	/** What it is doing right now. `"done"` covers success and failure alike. */
	status: SubagentStatus;
	/** The task it was given. Empty until the first `ask`. */
	task: string;
	/** Every tool call so far, in order. The last one is what the collapsed row shows. */
	tools: ToolCall[];
	/** Assistant text, accumulated from the deltas. */
	output: string;
	/** Cumulative since spawn - for a persistent subagent, that is several turns. */
	usage: Usage;
	/**
	 * How far under a root it sits: `0` for a root, one more per level of
	 * delegation. Decided when it spawns, from the parent the picture had seen
	 * by then - a parent it never saw leaves the child a root, never lost.
	 */
	depth: number;
	/** `provider/id` as pi resolved it, when it could. */
	model?: string;
	/** The subagent that had this one spawned. Absent on a root. */
	parentId?: string;
	/**
	 * Monotonic instant the current turn began, while one is running.
	 *
	 * `usage.busyMs` only lands when the turn ends, so without this the widget
	 * would read `0.0s` for the whole wait and then jump straight to the total.
	 */
	startedAt?: number;
	/** Whether its last turn succeeded. Absent until it has finished one. */
	ok?: boolean;
	/** The failure, when there was one - shown on the row rather than swallowed. */
	error?: string;
};

/** The whole picture: every subagent, plus what it adds up to. */
export type RunSnapshot = {
	/** In launch order, so a fan-out reads top to bottom as it was launched. */
	subagents: SubagentSnapshot[];
	/** Finished, whatever the outcome. */
	done: number;
	/** Currently working. */
	running: number;
	/** Finished with `ok: false`. Counted apart: `2/3 done` hides a crash. */
	failed: number;
	/** Spawned so far, which is what `done` and `running` are counted against. */
	total: number;
	/** Sum over every subagent. `wallMs` is filled in by the caller. */
	usage: Usage;
};

/** The live picture of a run: subscribe it, then read it whenever you draw. */
export type RunPicture = {
	/** Subscribe this to the event bus. */
	reporter: EventListener;
	/** The current picture. Cheap enough to call on every frame. */
	snapshot(): RunSnapshot;
	/** One subagent, or nothing if the picture never saw it spawn. */
	of(id: string): SubagentSnapshot | undefined;
	/** Called on every event, so a display knows when to redraw. */
	onChange(listener: () => void): void;
};

/**
 * Folds subagent events into a picture.
 *
 * A fan-out reads top to bottom in the order the branches were launched, not in
 * the order they finish and not in the order their sessions came up. The last
 * one is why this sorts rather than trusting arrival: `spawn` cannot be emitted
 * before the session exists, since it carries the model pi resolved, and three
 * scouts launched together drew as `scout#2, scout#1, scout#3`.
 */
export function createRunPicture(): RunPicture {
	const byId = new Map<string, SubagentSnapshot>();
	/** Apart from the snapshot: where a row is drawn is the display's business. */
	const launched = new Map<string, number>();
	const listeners: (() => void)[] = [];

	const touch = () => {
		for (const listener of listeners) listener();
	};

	const reporter: EventListener = (event) => {
		if (event.type === "spawn") {
			launched.set(event.id, event.order);
			const parent = event.parentId ? byId.get(event.parentId) : undefined;
			byId.set(event.id, {
				id: event.id,
				agent: event.agent,
				lifetime: event.lifetime,
				status: "idle",
				task: "",
				tools: [],
				output: "",
				usage: emptyUsage(),
				depth: parent ? parent.depth + 1 : 0,
				model: event.model,
				parentId: event.parentId,
			});
			touch();
			return;
		}

		const snapshot = byId.get(event.id);
		if (!snapshot) return;

		switch (event.type) {
			case "status":
				snapshot.status = event.status;
				// The task rides on the "working" transition: a persistent
				// subagent gets several, and the last one is the current one.
				if (event.task !== undefined) snapshot.task = event.task;
				// Start the live clock when it starts working, stop it otherwise.
				snapshot.startedAt = event.status === "working" ? performance.now() : undefined;
				break;
			case "tool":
				snapshot.tools.push({ name: event.name, args: event.args });
				break;
			case "text":
				snapshot.output += event.delta;
				break;
			case "usage":
				snapshot.usage = event.usage;
				break;
			case "close":
				snapshot.usage = event.result.usage;
				snapshot.ok = event.result.ok;
				snapshot.error = event.result.error;
				snapshot.status = "done";
				break;
		}
		touch();
	};

	return {
		reporter,
		of: (id) => byId.get(id),
		onChange: (listener) => void listeners.push(listener),
		snapshot: () =>
			snapshotFrom([...byId.values()].sort((one, other) => (launched.get(one.id) ?? 0) - (launched.get(other.id) ?? 0))),
	};
}

/**
 * What a list of subagents adds up to, in the order it was given.
 *
 * The one place the counts and the total are derived: the live picture calls
 * it on every frame, and a reader handed the subagents alone - the tool's
 * result, once pi has serialised it - calls it to get the same picture back.
 *
 * `wallMs` stays 0: a list of subagents cannot know the elapsed time, and the
 * caller passes the real one to `formatUsage`/`usageReport` when it has one.
 */
export function snapshotFrom(subagents: readonly SubagentSnapshot[]): RunSnapshot {
	return {
		subagents: [...subagents],
		total: subagents.length,
		done: subagents.filter((one) => one.status === "done").length,
		running: subagents.filter((one) => one.status === "working").length,
		failed: subagents.filter((one) => one.ok === false).length,
		usage: sumUsage(
			subagents.map((one) => one.usage),
			0,
		),
	};
}
