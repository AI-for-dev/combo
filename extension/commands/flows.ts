/**
 * `/flows`: the flows there are, where each comes from and what it can cost;
 * `/flows <name>`: one flow's plan.
 *
 * Both run the flow stage only, the one that needs no launch: the file, the
 * flows it calls and the agents it names. The run stage (the tree, the ports,
 * whether somebody is there) belongs to a launch, so a flow listed here as
 * valid can still be refused by `/run`. A broken file is listed **beside** the
 * good ones, with every fault, since it is the most likely reason anyone is
 * looking; so is a file left in an old `pipelines/` directory, which nothing
 * reads any more and which would otherwise lose its name to a flow in silence.
 */

import { homedir } from "node:os";
import * as path from "node:path";
import { checkFlow, planOf, plural, showBound, showPlan, type AgentSource, type Fault, type FlowCatalogue, type RemovedPipeline } from "../../src/index.ts";
import { loadFlows } from "../command.ts";
import { resolved, type CommandDeps } from "../deps.ts";
import type { CommandCtx, PiApi } from "../pi.ts";

/** A line of what `/flows` shows, and the column its text goes on at when the terminal is narrower than the line. */
export type Row = { readonly text: string; readonly hang: number };

/** What `/flows` shows, and whether anything in it is refused. */
export type Listing = { readonly rows: readonly Row[]; readonly broken: boolean };

/** A flow checked, with its bound and description, or a file refused, with its faults. */
type Entry = { readonly name: string; readonly source: AgentSource; readonly faults: readonly Fault[]; readonly bound?: string; readonly description?: string };

/** How wide each column of the listing is. */
type Widths = { readonly name: number; readonly source: number; readonly bound: number };

/** Registers `/flows`. */
export default function registerFlowsCommand(pi: PiApi) {
	pi.registerCommand("flows", {
		description: "List the flows, where each comes from and what it can cost; with a name, print that flow's plan",
		handler: async (args, ctx: CommandCtx) => {
			showFlows(args, ctx);
		},
	});
}

/**
 * One line per flow, by name: where it comes from, its bound in turns and
 * time, and its description. A broken one says so, its faults under it, one
 * per line; a removed pipeline is one of those, sorted beside the flow that
 * would otherwise take its name without a word. A count comes first.
 */
export function flowLines(catalogue: FlowCatalogue, removed: readonly RemovedPipeline[]): Listing {
	const entries = [...catalogue.flows.map(({ name, source }) => checkedEntry(name, source, catalogue)), ...removed.map(removedEntry)].sort((a, b) => a.name.localeCompare(b.name));
	const refused = entries.filter((entry) => entry.faults.length > 0).length;
	const count = `${plural(entries.length - refused, "flow")}${refused > 0 ? `, ${plural(refused, "file")} refused` : ""}`;
	const widths = widthsOf(entries);
	return { rows: [{ text: count, hang: 0 }, ...entries.flatMap((entry) => entryRows(entry, widths))], broken: refused > 0 };
}

/**
 * The plan of the flow `name`, or its faults; then what is left under that
 * name in an old `pipelines/` directory, since that file may well be what the
 * person asking meant.
 */
export function planLines(name: string, catalogue: FlowCatalogue, removed: readonly RemovedPipeline[]): Listing {
	const checked = checkFlow(name, catalogue);
	const shown = checked.ok
		? showPlan(planOf(checked.flow)).split("\n").map((text) => ({ text, hang: text.search(/\S/) + 2 }))
		: [{ text: `${name}  broken`, hang: 0 }, ...faultRows(checked.faults)];
	const left = removed.filter((one) => one.name === name).map(removedEntry);
	const widths = widthsOf(left);
	return { rows: [...shown, ...left.flatMap((entry) => [{ text: "", hang: 0 }, ...entryRows(entry, widths)])], broken: !checked.ok || left.length > 0 };
}

/** `/flows [<name>]`: the listing, or one flow's plan, cut to the terminal. */
export function showFlows(args: string, ctx: CommandCtx, deps: CommandDeps = {}, width = process.stdout.columns): string[] {
	const all = resolved(deps);
	const catalogue = loadFlows(ctx, all);
	const removed = all.removedPipelines({ cwd: ctx.cwd, scope: "both" });
	const name = args.trim();
	const { rows, broken } = name === "" ? flowLines(catalogue, removed) : planLines(name, catalogue, removed);
	// pi draws a notification one column in, and a line as wide as the terminal would wrap again.
	const lines = rows.flatMap((row) => wrap({ ...row, text: tidy(row.text, ctx.cwd) }, width === undefined ? undefined : width - 2));
	ctx.ui.notify(lines.join("\n"), broken ? "warning" : "info");
	return lines;
}

function checkedEntry(name: string, source: AgentSource, catalogue: FlowCatalogue): Entry {
	const checked = checkFlow(name, catalogue);
	if (!checked.ok) return { name, source, faults: checked.faults };
	return { name, source, faults: [], bound: showBound(checked.flow.bounds.total), description: checked.flow.description };
}

function removedEntry({ name, source, fault }: RemovedPipeline): Entry {
	return { name, source, faults: [fault] };
}

function widthsOf(entries: readonly Entry[]): Widths {
	const widest = (of: (entry: Entry) => string) => Math.max(0, ...entries.map((entry) => of(entry).length));
	return { name: widest((entry) => entry.name), source: widest((entry) => entry.source), bound: widest((entry) => entry.bound ?? "broken") };
}

/** An entry's line, its description going on under itself, then its faults. */
function entryRows(entry: Entry, widths: Widths): Row[] {
	const columns = [entry.name.padEnd(widths.name), entry.source.padEnd(widths.source), (entry.bound ?? "broken").padEnd(widths.bound)];
	const text = [...columns, entry.description ?? ""].join("  ").trimEnd();
	return [{ text, hang: columns.join("  ").length + 2 }, ...faultRows(entry.faults)];
}

/** Faults the way a listing writes them, one per line and indented: `file at: message`. */
function faultRows(faults: readonly Fault[]): Row[] {
	return faults.map(({ file, at, message }) => {
		const where = [file, at].filter((part) => part !== "").join(" ");
		return { text: `  ${where === "" ? message : `${where}: ${message}`}`, hang: 4 };
	});
}

/** `text` with the working directory left out of its paths, and the home directory written `~`. */
function tidy(text: string, cwd: string): string {
	return text.replaceAll(`${cwd}${path.sep}`, "").replaceAll(`${homedir()}${path.sep}`, `~${path.sep}`);
}

/**
 * A row cut to `width`, each line after the first starting at its `hang`:
 * after a ` · ` when one fits, so a fact of a plan stays whole, else at a
 * space. A word wider than the room is left whole, for the terminal to wrap.
 */
function wrap({ text, hang }: Row, width: number | undefined): string[] {
	const lines: string[] = [];
	let rest = text;
	while (width !== undefined && rest.length > width) {
		const dot = factEnd(rest, width - 2);
		const space = rest.lastIndexOf(" ", width);
		const [end, next] = dot > hang ? [dot + 2, dot + 3] : [space, space + 1];
		if (end <= hang) break;
		lines.push(rest.slice(0, end));
		rest = `${" ".repeat(hang)}${rest.slice(next)}`;
	}
	return [...lines, rest];
}

/**
 * The last ` · ` starting at or before `from` that ends a fact, `-1` for
 * none. A bound is two facts joined the same way, `≤ 4 turns · ≤ 1h`, and
 * reads as one: it is not cut between its turns and its time.
 */
function factEnd(text: string, from: number): number {
	for (let at = text.lastIndexOf(" · ", from); at >= 0; at = text.lastIndexOf(" · ", at - 1)) {
		const start = at === 0 ? -1 : text.lastIndexOf(" · ", at - 1);
		const before = text.slice(start < 0 ? 0 : start + 3, at);
		if (!(before.startsWith("≤ ") && text.startsWith("≤ ", at + 3))) return at;
		if (at === 0) break;
	}
	return -1;
}
