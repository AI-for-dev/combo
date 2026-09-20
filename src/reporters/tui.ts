/**
 * Formatting for the pi TUI, with no pi-tui in sight.
 *
 * This file turns a {@link RunSnapshot} into strings and rows; the extension
 * draws them. Nothing here holds state - the picture is `picture.ts`, folded
 * once for every reader - so a line is tested by calling the function that
 * makes it, never by scraping a terminal.
 */

import type { SubagentStatus } from "../events.ts";
import { firstLine, scalar, truncate } from "../text.ts";
import { compact, formatUsage } from "../usage.ts";
import type { RunSnapshot, SubagentSnapshot } from "./picture.ts";
import { treeOrder } from "./tree.ts";

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
 * Two lines while it works: the dot with what it is doing, then a dimmed line
 * with model, tokens and time. **One** line once it is over, because the second
 * line of a finished subagent held its last tool call, which nobody needs any
 * more; its numbers move up beside the tick instead. A fan-out of three took
 * seven lines from the first dot to the last, and now shrinks as it finishes.
 *
 * Colour is not applied here; the caller wraps the lines, because a colour code
 * depends on a theme this file must not know about. It gets {@link widgetRows}
 * instead, which says *what* each line is.
 */
export type WidgetRow =
	| {
			kind: "activity";
			icon: string;
			status: SubagentStatus | "failed";
			id: string;
			activity: string;
			/** Model, tokens and time, when they belong on this line rather than under it. */
			detail?: string;
			depth: number;
	  }
	| { kind: "detail"; text: string; depth: number };

/**
 * The widget, as rows that say what they are.
 *
 * Layout without colour, so it can be asserted on without a terminal. `depth`
 * is how far under a root the subagent sits; the caller turns it into indent,
 * because how wide a level is drawn is a decision about a terminal.
 */
export function widgetRows(snapshot: RunSnapshot): WidgetRow[] {
	const rows: WidgetRow[] = [];

	for (const one of treeOrder(snapshot.subagents)) {
		const failed = one.ok === false;
		const over = failed || one.status === "done";
		rows.push({
			kind: "activity",
			// A filled dot while it lives, a verdict once it is over.
			icon: failed ? "✗" : one.status === "done" ? "✓" : "●",
			status: failed ? "failed" : one.status,
			id: one.id,
			// A tick already says "done"; an error says something the tick cannot.
			activity: over && !failed ? "" : currentActivity(one),
			...(over ? { detail: detailLine(one) } : {}),
			depth: one.depth,
		});
		if (!over) rows.push({ kind: "detail", text: detailLine(one), depth: one.depth });
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

/** `provider/model · ↑12k ↓209 · 12.4s` */
export function detailLine(snapshot: SubagentSnapshot, now?: number): string {
	const parts: string[] = [];
	if (snapshot.model) parts.push(snapshot.model);
	parts.push(`↑${compact(snapshot.usage.input)} ↓${compact(snapshot.usage.output)}`);
	parts.push(`${(elapsedMs(snapshot, now) / 1000).toFixed(1)}s`);
	if (snapshot.usage.cost > 0) parts.push(`$${snapshot.usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

/** Plain text rows, for a caller with no theme - and for tests. */
export function widgetLines(snapshot: RunSnapshot): string[] {
	return widgetRows(snapshot).map((row) => {
		const indent = "  ".repeat(row.depth);
		if (row.kind === "detail") return `${indent}  ${row.text}`;
		return [`${indent}${row.icon} ${row.id}`, row.activity, row.detail].filter(Boolean).join("  ");
	});
}

/** `2/3 done, 1 running` - what a parallel run looks like while it runs. */
export function progressLine(snapshot: RunSnapshot): string {
	const parts = [`${snapshot.done}/${snapshot.total} done`];
	if (snapshot.running > 0) parts.push(`${snapshot.running} running`);
	if (snapshot.failed > 0) parts.push(`${snapshot.failed} failed`);
	return parts.join(", ");
}

/**
 * The end-of-workflow table: one line per subagent, total at the bottom.
 *
 * `wallMs` is passed in because a snapshot cannot know it: on a fan-out the
 * elapsed time is not the sum of the branches, and that difference is the
 * whole point of the number.
 *
 * A delegated subagent is indented under the one that asked for it, and the
 * total is still the sum of every row: what ruins a run is what the tree cost
 * altogether, never what one leaf of it cost.
 */
export function summaryTable(snapshot: RunSnapshot, wallMs: number): string[] {
	const lines = treeOrder(snapshot.subagents).map(
		(one) => `${statusIcon(one)} ${pad(`${"  ".repeat(one.depth)}${one.id}`, 16)} ${formatUsage(one.usage)}`,
	);
	lines.push(`${pad("total", 18)} ${formatUsage({ ...snapshot.usage, wallMs })}`);
	if (wallMs > 0 && snapshot.usage.busyMs > wallMs) {
		lines.push(`parallelism ×${(snapshot.usage.busyMs / wallMs).toFixed(2)}`);
	}
	return lines;
}

function tilde(filePath: string | undefined): string {
	if (!filePath) return "";
	const home = process.env.HOME;
	return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}
