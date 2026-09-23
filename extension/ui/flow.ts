/**
 * A flow run, painted: its plan as `livePlan` fills it, and under a visit
 * running now, what each of its subagents is doing.
 *
 * The same painter draws the widget while the run goes and the frame its
 * answer ends on, so the two cannot disagree about what a line says. What a
 * line holds is the library's (`liveRows`); what a subagent is doing is the
 * TUI's own pieces (`currentActivity`, `detailLine`), the ones the widget of
 * a run with no plan is built from. This file only colours and cuts.
 */

import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	currentActivity,
	detailLine,
	liveRows,
	showSummary,
	standingOf,
	statusColour,
	statusIcon,
	treeOrder,
	truncate,
	type LivePlan,
	type LiveState,
	type RunSnapshot,
	type SubagentSnapshot,
} from "../../src/index.ts";
import type { Widget, WidgetTheme } from "../pi.ts";

/** What a paint may vary: the subagents to show under their visit, the one selected, and how many rows the plan may take. */
export type FlowPaint = {
	/** The run's subagents, for the activity under a running visit. Absent draws the plan alone. */
	snapshot?: RunSnapshot;
	/** The subagent a key would stop, marked `▸`. */
	selected?: string;
	/** How many rows the plan may take under its summary, the cuts counted among them. Absent cuts none. */
	maxRows?: number;
	/** The working directory, left out of the paths a line names. Defaults to this process's. */
	cwd?: string;
};

/**
 * How many rows of a flow's plan the widget takes under its summary. The
 * whole plan of `build` is taller than a terminal, and would push the prompt
 * off the screen.
 */
const PLAN_ROWS = 16;

/**
 * The widget above the prompt while a flow runs: its plan, `footer` under it,
 * drawn one column in from each edge as pi draws a widget given as lines.
 * The footer is asked for at each draw, since a question card coming up
 * changes what it says before the next paint.
 */
export function planWidget(live: LivePlan, theme: WidgetTheme, paint: Pick<FlowPaint, "snapshot" | "selected">, footer: () => readonly string[]): Widget {
	const render = (width: number) => [...paintFlow(live, theme, width - 2, { ...paint, maxRows: PLAN_ROWS }), ...footer()].map((line) => ` ${line}`);
	return () => ({ render, invalidate() {} });
}

/** A line of the plan, painted, and whether it is about what runs now. */
type Painted = { readonly text: string; readonly live: boolean };

/**
 * `live` as coloured lines, none wider than `width`. Past `maxRows`, the
 * plan is cut above and below what runs now, and each cut says how many
 * lines it holds: the finished lines above are the ones to lose first, and
 * what runs is what the widget is for.
 */
export function paintFlow(live: LivePlan, theme: WidgetTheme, width: number, paint: FlowPaint = {}): string[] {
	const { snapshot, selected, maxRows, cwd = process.cwd() } = paint;
	const subagents = snapshot === undefined ? [] : treeOrder(snapshot.subagents);
	const body = liveRows(live).flatMap((row): Painted[] => {
		const indent = "  ".repeat(row.depth);
		const quiet = row.state === "pending" || row.state === "unreached";
		// Who works on it is drawn under it when the picture knows them, and named on it otherwise.
		const unseen = row.subagents.filter((id) => !subagents.some((one) => one.id === id));
		const text = truncate(tidy([row.text, ...(unseen.length > 0 ? [unseen.join(", ")] : [])].join(" · "), cwd), width - indent.length - 2);
		const line = { text: `${indent}${theme.fg(colourOf(row.state), row.glyph)} ${theme.fg(quiet ? "dim" : "text", text)}`, live: row.state === "working" || row.state === "blocked" };
		// A subagent's line, then the ones it delegated to, under the visit it serves.
		const under = row.subagents.flatMap((id) => subtree(subagents, id)).map(({ one, depth }) => {
			const lead = `${indent}${"  ".repeat(depth + 1)}`;
			const standing = standingOf(one);
			const marked = one.id === selected && standing !== "done";
			const dot = marked ? theme.fg("accent", "▸") : theme.fg(statusColour(standing), statusIcon(standing));
			const [id = "", activity = "", detail = ""] = fit([one.id, tidy(currentActivity(one), cwd), detailLine(one)], width - lead.length - 2);
			return { text: `${lead}${dot} ${theme.fg(marked ? "accent" : "toolTitle", id)}  ${theme.fg("muted", activity)}  ${theme.fg("dim", detail)}`.trimEnd(), live: true };
		});
		return [line, ...under];
	});
	const summary = theme.fg(colourOf(live.summary.state), showSummary(live, width));
	return [summary, ...windowed(body, maxRows, theme)];
}

/**
 * `body` in at most `rows` lines: from the first line about what runs now,
 * or as far up as the room allows, each side cut saying how many it holds.
 */
function windowed(body: readonly Painted[], rows: number | undefined, theme: WidgetTheme): string[] {
	if (rows === undefined || body.length <= rows) return body.map((line) => line.text);
	const first = Math.max(0, body.findIndex((line) => line.live));
	// A cut above takes a row to say so, which the lines below can spare.
	const start = first === 0 ? 0 : Math.min(first, body.length - rows + 1);
	const room = rows - (start > 0 ? 1 : 0);
	// A cut below takes a row too, never the last one left.
	const end = start + room < body.length ? Math.max(start + 1, start + room - 1) : body.length;
	const cut = (count: number, where: string) => theme.fg("dim", `… ${count} ${count === 1 ? "line" : "lines"} ${where}`);
	return [...(start > 0 ? [cut(start, "above")] : []), ...body.slice(start, end).map((line) => line.text), ...(end < body.length ? [cut(body.length - end, "below")] : [])];
}

/** Where this package is installed: what it ships is named from there, `agents/scout.md`. */
const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));

/**
 * `text` with the working directory and this package left out of its paths,
 * and the home directory written `~`. A shipped agent reads `agents/coder.md`
 * where a repository's reads `.pi/agents/coder.md`, and neither takes half a
 * line of the terminal to say it.
 */
export function tidy(text: string, cwd: string): string {
	return text.replaceAll(`${cwd}${path.sep}`, "").replaceAll(PACKAGE, "").replaceAll(`${homedir()}${path.sep}`, `~${path.sep}`);
}

/** The colour a visit's standing is drawn in: a subagent's, and dim for what has not run. */
function colourOf(state: LiveState): string {
	return state === "pending" || state === "unreached" ? "dim" : statusColour(state);
}

/** The subagent `id` of `ordered` and each one under it, their depth counted from it. */
function subtree(ordered: readonly SubagentSnapshot[], id: string): { one: SubagentSnapshot; depth: number }[] {
	const at = ordered.findIndex((one) => one.id === id);
	const root = ordered[at];
	if (root === undefined) return [];
	const end = ordered.findIndex((one, i) => i > at && one.depth <= root.depth);
	return ordered.slice(at, end < 0 ? undefined : end).map((one) => ({ one, depth: one.depth - root.depth }));
}

/** `parts` cut, first to last, so that joined by two spaces they take no more than `room`. */
function fit(parts: readonly string[], room: number): string[] {
	let left = room;
	return parts.map((part) => {
		const kept = left <= 0 ? "" : part.length > left ? truncate(part, left) : part;
		left -= kept.length + 2;
		return kept;
	});
}

/** A flow's last frame as a component: painted again at whatever width pi draws it. */
export class PlanFrame {
	private readonly live: LivePlan;
	private readonly theme: WidgetTheme;

	constructor(live: LivePlan, theme: WidgetTheme) {
		this.live = live;
		this.theme = theme;
	}

	render(width: number): string[] {
		return paintFlow(this.live, this.theme, width);
	}

	invalidate(): void {}
}
