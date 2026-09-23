/**
 * The lives of a flow run, read from its journal: its first start, then each
 * resume, each opened by a `life_start` entry.
 *
 * Two readers take them: `usage.json`, which rebuilds a life killed before it
 * wrote its own, and the live view's summary. A life's cost is what its ended
 * visits say, each counted once at the outermost visit holding it, since a
 * visit's usage includes every visit inside it. Nothing else is known of a
 * life that did not end, and nothing is estimated.
 */

import type { JournalEntry, VisitEnd } from "../flow/index.ts";
import { sumUsage, type Usage } from "../usage.ts";
import type { LifeUsage } from "./export.ts";

type RunEnd = Extract<JournalEntry, { type: "run_end" }>;

/** One life as its journal holds it: when it started, the visits it ended, and its end when it wrote one. */
export type JournalLife = { readonly startedAt?: string; readonly ends: VisitEnd[]; readonly runEnd?: RunEnd };

/** The lives `journal` holds, in order. What comes before any `life_start` is a life of its own. */
export function livesOf(journal: readonly JournalEntry[]): JournalLife[] {
	const lives: { startedAt?: string; ends: VisitEnd[]; runEnd?: RunEnd }[] = [];
	for (const entry of journal) {
		if (entry.type === "life_start" || lives.length === 0) lives.push({ ...(entry.type === "life_start" && { startedAt: entry.startedAt }), ends: [] });
		const life = lives.at(-1) as (typeof lives)[number];
		if (entry.type === "visit_end") life.ends.push(entry);
		else if (entry.type === "run_end") life.runEnd = entry;
	}
	return lives;
}

/** How a life ended: well, failed, or stopped or killed before its end. */
export function lifeEnd(runEnd: RunEnd | undefined): LifeUsage["end"] {
	if (runEnd === undefined || runEnd.error?.kind === "stopped") return "interrupted";
	return runEnd.ok ? "ok" : "failed";
}

/** A life rebuilt from its journal alone: its end's usage when it wrote one, else what its ended visits cost. */
export function rebuiltLife(life: JournalLife): LifeUsage {
	const usage = life.runEnd?.usage ?? costOf(life.ends);
	return { startedAt: life.startedAt ?? "", wallMs: usage.wallMs, usage, end: lifeEnd(life.runEnd), partial: true };
}

/**
 * What a set of ended visits cost: each counted once, at the outermost visit
 * that holds it. The time adds up, for the visits it counts ran one after
 * the other, unless they were branches running together.
 */
export function costOf(ends: readonly VisitEnd[]): Usage {
	const paths = pathsOf(ends);
	const outermost = ends.filter((end) => holderIn(end.path, paths) === undefined);
	return sumUsage(
		outermost.map((end) => end.usage),
		outermost.reduce((sum, end) => sum + end.wallMs, 0),
	);
}

/**
 * `ends`, which come innermost first, in plan order: each visit before the
 * visits it holds, visits under one holder in the order they ended.
 */
export function planOrder(ends: readonly VisitEnd[]): VisitEnd[] {
	const paths = pathsOf(ends);
	const under = new Map<string | undefined, VisitEnd[]>();
	for (const end of ends) {
		const holder = holderIn(end.path, paths);
		under.set(holder, [...(under.get(holder) ?? []), end]);
	}
	const walk = (holder: string | undefined): VisitEnd[] => (under.get(holder) ?? []).flatMap((end) => [end, ...walk(end.path)]);
	return walk(undefined);
}

function pathsOf(ends: readonly VisitEnd[]): ReadonlySet<string> {
	return new Set(ends.map((end) => end.path));
}

/** The innermost of `paths` that holds the visit `path`. */
function holderIn(path: string, paths: ReadonlySet<string>): string | undefined {
	return holders(path).findLast((one) => paths.has(one));
}

/** The visits that can hold the visit `path`, outermost first: each segment before its last, an iteration or an item read as its loop or `map`. */
function holders(path: string): string[] {
	const segments = path.split("/");
	return segments.slice(1).map((_, i) =>
		segments
			.slice(0, i + 1)
			.join("/")
			.replace(/(#\d+|\[\d+\])$/, ""),
	);
}
