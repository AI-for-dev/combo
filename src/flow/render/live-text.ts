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

/** `live` as lines of text, none longer than `width`, pure. */
export function showLive(live: LivePlan, width: number): string {
	const rows = [summaryText(live.flow, live.summary), ...live.lines.flatMap((line) => shown(line, 0))];
	return rows.map((row) => cut(row, width)).join("\n");
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

function shown(line: LiveLine, depth: number): string[] {
	const parts = [
		line.label,
		...line.facts,
		// Who is working on a visit now; once it ended, the agent it ran is in its facts.
		...(live(line.state) && line.subagents.length > 0 ? [line.subagents.join(", ")] : []),
		...(line.bound === undefined ? [] : [showBound(line.bound)]),
		...(line.usage === undefined ? [] : [cost(line.usage)]),
	].filter((part) => part !== "");
	return [`${"  ".repeat(depth)}${glyph(line.state)} ${parts.join(" · ")}`, ...line.lines.flatMap((one) => shown(one, depth + 1))];
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
