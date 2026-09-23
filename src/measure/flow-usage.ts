/**
 * The part of `usage.json` a flow run adds: its visits, its nodes and its
 * lives.
 *
 * This life's visits are folded from the `visit_end` events the measurement
 * hears, and each subagent's transcript from its `spawn`. The earlier lives
 * are what the run directory holds: the `usage.json` the last measured life
 * wrote, and the journal for a life killed before it wrote one. The runner
 * writes no measurement, so unplugging this leaves a run and its resume as
 * they were.
 */

import fs from "node:fs";
import path from "node:path";
import type { EventListener } from "../events.ts";
// Past the door on purpose: `flow/index.ts` re-exports the runner, which
// spawns, and a subagent exports through this module.
import { readJournal } from "../flow/run/journal.ts";
import type { JournalEntry, VisitEnd } from "../flow/index.ts";
import { sumUsage } from "../usage.ts";
import type { LifeUsage, NodeUsage, UsageReport, UsageReportEntry, VisitUsage } from "./export.ts";
import { lifeEnd, livesOf, planOrder, rebuiltLife } from "./lives.ts";

/** What a measurement heard of a flow: the visits this life ended, and where each subagent's transcript went. */
export type FlowFold = { readonly listener: EventListener; readonly ends: readonly VisitEnd[]; readonly transcripts: ReadonlyMap<string, string> };

/** Folds the visit ends and the transcripts of the stream it is subscribed to. */
export function flowFold(): FlowFold {
	const ends: VisitEnd[] = [];
	const transcripts = new Map<string, string>();
	return {
		listener: (event) => {
			if (event.type === "visit_end") ends.push(event);
			else if (event.type === "spawn" && event.transcript !== undefined) transcripts.set(event.id, event.transcript);
		},
		ends,
		transcripts,
	};
}

/**
 * `report`, this life's, with the flow's part added: unchanged when the run
 * told no visit and `dir` holds no journal. `opened` is when this
 * measurement began, which tells this life's `life_start` from an earlier
 * one's when the run it measured never started.
 */
export function withFlow(report: UsageReport, fold: FlowFold, dir: string | undefined, opened: Date): UsageReport {
	const journal = dir === undefined ? [] : journalIn(dir);
	if (fold.ends.length === 0 && journal.length === 0) return report;
	const lives = livesOf(journal);
	const current = lives.at(-1);
	const own = current?.startedAt !== undefined && Date.parse(current.startedAt) >= opened.getTime() ? lives.pop() : undefined;
	const before = dir === undefined ? undefined : reportIn(dir);
	const kept = (before?.lives ?? []).slice(0, lives.length);
	const rebuilt = lives.slice(kept.length);
	const life = lives.length + 1;
	const visits = [
		...(before?.visits ?? []).filter((one) => one.life <= kept.length),
		...rebuilt.flatMap((one, i) => visitsOf(one.ends, kept.length + i + 1)),
		...visitsOf(fold.ends, life),
	];
	const subagents = [...(before?.subagents ?? []).filter((one) => (one.life ?? 0) <= kept.length), ...report.subagents.map((one) => subagentOf(one, fold, dir, life))];
	const ownLife: LifeUsage = { startedAt: opened.toISOString(), wallMs: report.wallMs, usage: withoutCounts(report.total), end: lifeEnd(own?.runEnd) };
	const all = journal.length === 0 ? undefined : [...kept, ...rebuilt.map(rebuiltLife), ...(own === undefined ? [] : [ownLife])];
	if (all === undefined) return { ...report, subagents, visits, nodes: nodesOf(visits) };
	const wallMs = all.reduce((sum, one) => sum + one.wallMs, 0);
	const total = sumUsage(
		all.map((one) => one.usage),
		wallMs,
	);
	return {
		...report,
		wallMs,
		subagents,
		total: { ...total, subagents: subagents.length, failed: subagents.filter((one) => one.ok === false).length },
		parallelism: wallMs > 0 ? total.busyMs / wallMs : 0,
		visits,
		nodes: nodesOf(visits),
		lives: all,
	};
}

function visitsOf(ends: readonly VisitEnd[], life: number): VisitUsage[] {
	return planOrder(ends).map(({ path, node, kind, agent, subagent, ok, wallMs, usage }) => ({ path, node, kind, ...(agent !== undefined && { agent }), ...(subagent !== undefined && { subagent }), life, ok, wallMs, usage }));
}

/** This life's subagent `entry`, with where its transcript went and the visits it ran. */
function subagentOf(entry: UsageReportEntry, fold: FlowFold, dir: string | undefined, life: number): UsageReportEntry {
	const transcript = fold.transcripts.get(entry.id);
	const home = transcript !== undefined && dir !== undefined ? path.relative(dir, path.dirname(transcript)) : undefined;
	const visits = fold.ends.filter((end) => end.subagent === entry.id).map((end) => end.path);
	return { ...entry, ...(home !== undefined && { home }), life, visits };
}

/** One entry per node address, in the order first visited, its visits added up. */
function nodesOf(visits: readonly VisitUsage[]): NodeUsage[] {
	const nodes = new Map<string, VisitUsage[]>();
	for (const visit of visits) nodes.set(visit.node, [...(nodes.get(visit.node) ?? []), visit]);
	return [...nodes].map(([node, all]) => {
		const wallMs = all.reduce((sum, one) => sum + one.wallMs, 0);
		return {
			node,
			visits: all.length,
			wallMs,
			usage: sumUsage(
				all.map((one) => one.usage),
				wallMs,
			),
		};
	});
}

function withoutCounts({ subagents: _subagents, failed: _failed, ...usage }: UsageReport["total"]): LifeUsage["usage"] {
	return usage;
}

/** The journal in `dir`, or none when it cannot be read: a measurement never breaks a run. */
function journalIn(dir: string): JournalEntry[] {
	try {
		return readJournal(dir);
	} catch {
		return [];
	}
}

/** The `usage.json` an earlier life of a flow run left in `dir`, when there is one to read. */
function reportIn(dir: string): UsageReport | undefined {
	try {
		const report = JSON.parse(fs.readFileSync(path.join(dir, "usage.json"), "utf-8")) as UsageReport;
		return [report.lives, report.visits, report.subagents].every(Array.isArray) ? report : undefined;
	} catch {
		return undefined;
	}
}
