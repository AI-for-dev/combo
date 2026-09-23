/**
 * The live view as text: the summary line, then one line per live line,
 * indented under the line that holds it, each cut to the width the caller
 * draws in.
 *
 * The glyphs are the plan's `○` for what is not visited yet and the TUI's for
 * the rest, from `statusIcon`, so a flow's visit and a subagent's row read
 * alike; `–` marks a node its sequence never reached.
 */

import { statusIcon } from "../../reporters/tui.ts";
import { plural } from "../../text.ts";
import { compact, type Usage } from "../../usage.ts";
import { showBound, showDuration } from "../bounds.ts";
import type { LiveLine, LivePlan, LiveState } from "./live.ts";
import type { LiveSummary } from "./summary.ts";
import { NOT_VISITED } from "./text.ts";

/** What a node never reached is marked with. */
const UNREACHED = "–";

/** The kinds no model runs in: their line says how long they took, since `↑0 ↓0` there would read as a count. */
const TOKENLESS: ReadonlySet<LiveLine["kind"]> = new Set(["check", "commit", "ask"]);

/** One line of the live view as text, before any cut. */
export type LiveRow = {
	/** How many lines hold it. */
	readonly depth: number;
	/** How its visit stands, which a caller colours it by. */
	readonly state: LiveState;
	/** `●`, `✓`, `✗`, `○` or `–`. */
	readonly glyph: string;
	/** What it says after its glyph, facts joined by ` · `, without who works on it. */
	readonly text: string;
	/** The subagents of a visit running now, which {@link showLive} names after its text; none once it ended. */
	readonly subagents: readonly string[];
};

/** `live` as lines of text, none longer than `width`, pure. */
export function showLive(live: LivePlan, width: number): string {
	const rows = [summaryText(live.flow, live.summary), ...liveRows(live).map(rowText)];
	return rows.map((row) => cut(row, width)).join("\n");
}

/**
 * `live`'s lines under its summary, one row each, for a caller that draws
 * them its own way: in colour, with what each subagent is doing under its
 * visit. `subagents` are those of a visit running now.
 */
export function liveRows(live: LivePlan): LiveRow[] {
	return live.lines.flatMap((line) => rowsOf(line, 0));
}

/** A row as {@link showLive} writes it, indented, naming who works on it. */
function rowText(row: LiveRow): string {
	return `${"  ".repeat(row.depth)}${row.glyph} ${[row.text, ...(row.subagents.length > 0 ? [row.subagents.join(", ")] : [])].join(" · ")}`;
}

/** The one line `live` collapses to, no longer than `width`: `✓ build · 14 visits · 1 failed · deliver not converged · 12m · ↑310k ↓12k`. */
export function showSummary(live: LivePlan, width: number): string {
	return cut(summaryText(live.flow, live.summary), width);
}

function summaryText(flow: string, summary: LiveSummary): string {
	const { state, visits, failed, unconverged, usage, lives, partial, resumedFrom } = summary;
	return `${glyph(state)} ${[
		flow,
		plural(visits, "visit"),
		...(failed > 0 ? [`${failed} failed`] : []),
		...unconverged.map((path) => `${path} not converged`),
		cost(usage),
		...(lives > 1 ? [`${lives} lives${partial > 0 ? ` (${partial} partial)` : ""}`] : []),
		...(resumedFrom === undefined ? [] : [`resumed from ${resumedFrom}`]),
	].join(" · ")}`;
}

function rowsOf(line: LiveLine, depth: number): LiveRow[] {
	// Who is working on a visit now; once it ended, the agent it ran is in its facts.
	const subagents = live(line.state) ? line.subagents : [];
	const parts = [
		line.label,
		...line.facts,
		...(line.bound === undefined ? [] : [showBound(line.bound)]),
		...(line.usage === undefined ? [] : [TOKENLESS.has(line.kind) ? showDuration(line.usage.wallMs) : cost(line.usage)]),
	].filter((part) => part !== "");
	return [{ depth, state: line.state, glyph: glyph(line.state), text: parts.join(" · "), subagents }, ...line.lines.flatMap((one) => rowsOf(one, depth + 1))];
}

function live(state: LiveState): boolean {
	return state === "working" || state === "blocked";
}

function glyph(state: LiveState): string {
	if (state === "pending") return NOT_VISITED;
	if (state === "unreached") return UNREACHED;
	return statusIcon(state);
}

/** `3m12s · ↑41k ↓2.1k`, and what it cost when pi said. */
function cost(usage: Usage): string {
	return [showDuration(usage.wallMs), `↑${compact(usage.input)} ↓${compact(usage.output)}`, ...(usage.cost > 0 ? [`$${usage.cost.toFixed(4)}`] : [])].join(" · ");
}

/** `row` cut to `width`, marked when something was. Unlike `truncate`, it keeps the indent. */
function cut(row: string, width: number): string {
	return row.length > width ? `${row.slice(0, Math.max(0, width - 1))}…` : row;
}
