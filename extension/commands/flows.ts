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

import { checkFlow, planOf, plural, showBound, showPlan, type AgentSource, type Fault, type FlowCatalogue, type RemovedPipeline } from "../../src/index.ts";
import { loadFlows } from "../command.ts";
import { resolved, type CommandDeps } from "../deps.ts";
import type { CommandCtx, PiApi } from "../pi.ts";
import { notified, type Row } from "../notice.ts";

/** What `/flows` shows. */
export type Listing = { readonly rows: readonly Row[] };

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
	return { rows: [{ text: count, hang: 0 }, ...entries.flatMap((entry) => entryRows(entry, widths))] };
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
		: [{ text: `${name}  broken`, hang: 0, refused: true }, ...faultRows(checked.faults)];
	const left = removed.filter((one) => one.name === name).map(removedEntry);
	const widths = widthsOf(left);
	return { rows: [...shown, ...left.flatMap((entry) => [{ text: "", hang: 0 }, ...entryRows(entry, widths)])] };
}

/**
 * `/flows [<name>]`: the listing, or one flow's plan, cut to the terminal.
 * A refused file's lines read as a warning and the rest as the listing they
 * are in: pi colours a notification whole, so each line carries its own.
 */
export function showFlows(args: string, ctx: CommandCtx, deps: CommandDeps = {}, width = process.stdout.columns): string[] {
	const all = resolved(deps);
	const catalogue = loadFlows(ctx, all);
	const removed = all.removedPipelines({ cwd: ctx.cwd, scope: "both" });
	const name = args.trim();
	const { rows } = name === "" ? flowLines(catalogue, removed) : planLines(name, catalogue, removed);
	const drawn = rows.map((row) => ({ row, lines: notified([row], ctx.cwd, width) }));
	ctx.ui.notify(drawn.flatMap(({ row, lines }) => lines.map((line) => ctx.ui.theme.fg(row.refused ? "warning" : "dim", line))).join("\n"), "info");
	return drawn.flatMap(({ lines }) => lines);
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
	return [{ text, hang: columns.join("  ").length + 2, ...(entry.faults.length > 0 && { refused: true }) }, ...faultRows(entry.faults)];
}

/** Faults the way a listing writes them, one per line and indented: `file at: message`. */
export function faultRows(faults: readonly Fault[]): Row[] {
	return faults.map(({ file, at, message }) => {
		const where = [file, at].filter((part) => part !== "").join(" ");
		return { text: `  ${where === "" ? message : `${where}: ${message}`}`, hang: 4, refused: true };
	});
}
