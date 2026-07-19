/**
 * State and formatting for the pi TUI, with no pi-tui in sight.
 *
 * The split matters: this file **collects** what happened, the extension
 * **draws** it. Collection is pure, so it is tested by inspecting a snapshot -
 * never by scraping a terminal rendering, which is the rule for every reporter
 * here. It also means the same state feeds a future web view or an export
 * without touching a component.
 */

import type { EventListener, SubagentStatus } from "../events.ts";
import { compact, emptyUsage, formatUsage, type Usage } from "../usage.ts";

/** A tool call as it happened, kept for the expanded view. */
export type ToolCall = { name: string; args: unknown };

/** Everything known about one subagent, at one instant. */
export type SubagentSnapshot = {
	id: string;
	agent: string;
	lifetime: string;
	status: SubagentStatus;
	/** The task it was given. Empty until the first `ask`. */
	task: string;
	tools: ToolCall[];
	/** Assistant text, accumulated from the deltas. */
	output: string;
	usage: Usage;
	/** `provider/id` as pi resolved it, when it could. */
	model?: string;
	/**
	 * Monotonic instant the current turn began, while one is running.
	 *
	 * `usage.busyMs` only lands when the turn ends, so without this the widget
	 * would read `0.0s` for the whole wait and then jump straight to the total.
	 */
	startedAt?: number;
	ok?: boolean;
	error?: string;
};

/** The whole picture: every subagent, plus what it adds up to. */
export type TuiSnapshot = {
	subagents: SubagentSnapshot[];
	/** Finished, whatever the outcome. */
	done: number;
	/** Currently working. */
	running: number;
	failed: number;
	total: number;
	/** Sum over every subagent. `wallMs` is filled in by the caller. */
	usage: Usage;
};

export type TuiCollector = {
	/** Subscribe this to the event bus. */
	reporter: EventListener;
	/** The current picture. Cheap enough to call on every frame. */
	snapshot(): TuiSnapshot;
	/** Called on every event, so the extension knows when to `invalidate()`. */
	onChange(listener: () => void): void;
	/**
	 * Records the task a subagent was given.
	 *
	 * The core does not emit it: a task belongs to an `ask`, not to a subagent,
	 * and a persistent one gets several. The caller knows which task it just
	 * handed over, so it tells us.
	 */
	setTask(id: string, task: string): void;
};

/**
 * Collects subagent events into a renderable snapshot.
 *
 * Insertion order is preserved: a fan-out reads top to bottom in the order the
 * branches were launched, not in the order they happen to finish.
 */
export function createTuiCollector(): TuiCollector {
	const byId = new Map<string, SubagentSnapshot>();
	const listeners: (() => void)[] = [];

	const touch = () => {
		for (const listener of listeners) listener();
	};

	const reporter: EventListener = (event) => {
		if (event.type === "spawn") {
			byId.set(event.id, {
				id: event.id,
				agent: event.agent,
				lifetime: event.lifetime,
				status: "idle",
				task: "",
				tools: [],
				output: "",
				usage: emptyUsage(),
				model: event.model,
			});
			touch();
			return;
		}

		const snapshot = byId.get(event.id);
		if (!snapshot) return;

		switch (event.type) {
			case "status":
				snapshot.status = event.status;
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
		onChange: (listener) => void listeners.push(listener),

		setTask(id, task) {
			const snapshot = byId.get(id);
			if (!snapshot) return;
			snapshot.task = task;
			touch();
		},

		snapshot() {
			const subagents = [...byId.values()];
			return {
				subagents,
				total: subagents.length,
				done: subagents.filter((one) => one.status === "done").length,
				running: subagents.filter((one) => one.status === "working").length,
				failed: subagents.filter((one) => one.ok === false).length,
				usage: sumSnapshots(subagents),
			};
		},
	};
}

function sumSnapshots(subagents: readonly SubagentSnapshot[]): Usage {
	const total = emptyUsage();
	for (const one of subagents) {
		total.busyMs += one.usage.busyMs;
		total.turns += one.usage.turns;
		total.input += one.usage.input;
		total.output += one.usage.output;
		total.cacheRead += one.usage.cacheRead;
		total.cacheWrite += one.usage.cacheWrite;
		total.cost += one.usage.cost;
	}
	return total;
}

/** `⏳` while it works, `✓` when it succeeded, `✗` when it did not. */
export function statusIcon(snapshot: SubagentSnapshot): string {
	if (snapshot.ok === false) return "✗";
	if (snapshot.status === "done") return "✓";
	return "⏳";
}

/**
 * Formats a tool call the way the pi TUI shows built-in tools.
 *
 * `$ cmd`, `read ~/path:1-10`, `grep /pat/ in ~/path` - shapes a pi user
 * already reads without thinking. Anything unknown degrades to `name arg=value`
 * rather than dumping raw JSON at them.
 */
export function formatToolCall(name: string, args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	const str = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined);
	const num = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : undefined);

	switch (name) {
		case "bash": {
			const command = str("command") ?? str("cmd");
			return command ? `$ ${firstLine(command)}` : "$";
		}
		case "read": {
			const file = str("path") ?? str("file") ?? str("filePath");
			const from = num("offset") ?? num("startLine");
			const count = num("limit") ?? num("lines");
			const range = from !== undefined ? `:${from}${count !== undefined ? `-${from + count}` : ""}` : "";
			return `read ${tilde(file)}${range}`;
		}
		case "grep": {
			const pattern = str("pattern") ?? str("query") ?? "";
			const where = str("path") ?? str("dir");
			return `grep /${pattern}/${where ? ` in ${tilde(where)}` : ""}`;
		}
		case "find":
			return `find ${str("pattern") ?? str("glob") ?? ""}`.trimEnd();
		case "ls":
			return `ls ${tilde(str("path"))}`;
		case "edit":
			return `edit ${tilde(str("path") ?? str("filePath"))}`;
		case "write":
			return `write ${tilde(str("path") ?? str("filePath"))}`;
		default: {
			const summary = Object.entries(record)
				.filter(([, value]) => value !== undefined && value !== null && value !== "")
				.slice(0, 3)
				.map(([key, value]) => `${key}=${truncate(scalar(value), 30)}`)
				.join(" ");
			return summary ? `${name} ${summary}` : name;
		}
	}
}

/** One compact line per subagent: `⏳ scout#1  find auth code  → grep`. */
export function collapsedLine(snapshot: SubagentSnapshot, width = 60): string {
	const parts = [statusIcon(snapshot), snapshot.id];
	if (snapshot.task) parts.push(truncate(firstLine(snapshot.task), width));
	const last = snapshot.tools.at(-1);
	if (last && snapshot.status !== "done") parts.push(`→ ${last.name}`);
	if (snapshot.error) parts.push(`(${truncate(snapshot.error, 40)})`);
	return parts.join("  ");
}

/**
 * What a subagent is doing *right now*, in a few words.
 *
 * The last tool call while it works; its verdict once it is done. This is the
 * "minimal information" of the widget - enough to know it is alive and on the
 * right track, not enough to read instead of the transcript.
 */
export function currentActivity(snapshot: SubagentSnapshot): string {
	if (snapshot.ok === false) return snapshot.error ? truncate(snapshot.error, 48) : "failed";
	if (snapshot.status === "done") return "done";

	const last = snapshot.tools.at(-1);
	if (last) return formatToolCall(last.name, last.args);
	return snapshot.status === "working" ? "thinking…" : "waiting";
}

/**
 * A dot per subagent, above the prompt - the Claude Code shape.
 *
 * Two lines each: the dot with what it is doing, then a dimmed line with model,
 * tokens and time. Colour is not applied here; the caller wraps the lines,
 * because a colour code depends on a theme this file must not know about. It
 * gets {@link widgetRows} instead, which says *what* each line is.
 */
export type WidgetRow =
	| { kind: "activity"; icon: string; status: SubagentStatus | "failed"; id: string; activity: string }
	| { kind: "detail"; text: string };

export function widgetRows(snapshot: TuiSnapshot): WidgetRow[] {
	const rows: WidgetRow[] = [];

	for (const one of snapshot.subagents) {
		rows.push({
			kind: "activity",
			// A filled dot while it lives, a verdict once it is over.
			icon: one.ok === false ? "✗" : one.status === "done" ? "✓" : "●",
			status: one.ok === false ? "failed" : one.status,
			id: one.id,
			activity: currentActivity(one),
		});
		rows.push({ kind: "detail", text: detailLine(one) });
	}

	return rows;
}

/**
 * Time on the clock for a subagent: counting up while it works, final once done.
 *
 * `now` is injectable so the live branch is testable; nothing else needs it.
 */
export function elapsedMs(snapshot: SubagentSnapshot, now = performance.now()): number {
	if (snapshot.startedAt !== undefined) return snapshot.usage.busyMs + (now - snapshot.startedAt);
	return snapshot.usage.busyMs;
}

/** `ilaas/qwen-3.6-35b-instruct · ↑12k ↓209 · 12.4s` */
export function detailLine(snapshot: SubagentSnapshot, now?: number): string {
	const parts: string[] = [];
	if (snapshot.model) parts.push(snapshot.model);
	parts.push(`↑${compact(snapshot.usage.input)} ↓${compact(snapshot.usage.output)}`);
	parts.push(`${(elapsedMs(snapshot, now) / 1000).toFixed(1)}s`);
	if (snapshot.usage.cost > 0) parts.push(`$${snapshot.usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

/** Plain text rows, for a caller with no theme - and for tests. */
export function widgetLines(snapshot: TuiSnapshot): string[] {
	return widgetRows(snapshot).map((row) =>
		row.kind === "activity" ? `${row.icon} ${row.id}  ${row.activity}` : `  ${row.text}`,
	);
}

/** `2/3 done, 1 running` - what a parallel run looks like while it runs. */
export function progressLine(snapshot: TuiSnapshot): string {
	const parts = [`${snapshot.done}/${snapshot.total} done`];
	if (snapshot.running > 0) parts.push(`${snapshot.running} running`);
	if (snapshot.failed > 0) parts.push(`${snapshot.failed} failed`);
	return parts.join(", ");
}

/**
 * The end-of-workflow table: one line per subagent, total at the bottom.
 *
 * `wallMs` is passed in because the collector cannot know it: on a fan-out the
 * elapsed time is not the sum of the branches, and that difference is the
 * whole point of the number.
 */
export function summaryTable(snapshot: TuiSnapshot, wallMs: number): string[] {
	const lines = snapshot.subagents.map((one) => `${statusIcon(one)} ${pad(one.id, 16)} ${formatUsage(one.usage)}`);
	lines.push(`${pad("total", 18)} ${formatUsage({ ...snapshot.usage, wallMs })}`);
	if (wallMs > 0 && snapshot.usage.busyMs > wallMs) {
		lines.push(`parallelism ×${(snapshot.usage.busyMs / wallMs).toFixed(2)}`);
	}
	return lines;
}

function scalar(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

function tilde(filePath: string | undefined): string {
	if (!filePath) return "";
	const home = process.env.HOME;
	return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}
