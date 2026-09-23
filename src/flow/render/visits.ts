/**
 * What a run's journal and its event stream say of its visits, read once for
 * the live view: how each visit last ended, which are running now, the
 * subagents each spawned, and the lives the run has had.
 *
 * The journal holds what earlier lives wrote and the events what this one
 * told, so one reading takes a finished run's journal alone, a live run's
 * stream alone, or a resume's journal and stream together. A visit's last end
 * is the one the frame draws, whichever life wrote it; a `copy_lost` forgets
 * every end under its branch, as a resume does.
 */

import { isVisit, type SubagentEvent } from "../../events.ts";
import { sumUsage, type Usage } from "../../usage.ts";
import type { CheckedFlow } from "../checked.ts";
import { resumePoint, type JournalEntry, type VisitEnd } from "../run/index.ts";

/** One life of a run: what it cost, and whether it was killed before it could write its end. */
export type Life = { readonly usage: Usage; readonly partial: boolean };

type RunEnd = Extract<JournalEntry, { type: "run_end" }>;

/** A run's visits as the journal and the stream left them. */
export class Visits {
	private readonly ends = new Map<string, VisitEnd>();
	/** Visits this life started and has not ended. */
	private readonly running = new Set<string>();
	private readonly spawned = new Map<string, string[]>();
	private readonly frozen = new Map<string, number>();
	readonly lives: Life[] = [];
	/** How the last life ended, when it wrote its end and no later life has begun. */
	readonly runEnd: RunEnd | undefined;
	/** The visit the last life picked up from, when it resumed an earlier one. */
	readonly resumedFrom: string | undefined;

	constructor(checked: CheckedFlow, journal: readonly JournalEntry[], events: readonly SubagentEvent[]) {
		let segment: VisitEnd[] = [];
		let start = 0;
		let runEnd: RunEnd | undefined;
		for (const [i, entry] of journal.entries()) {
			switch (entry.type) {
				case "visit_end":
					segment.push(entry);
					this.ends.set(entry.path, entry);
					break;
				case "map_items":
					this.frozen.set(entry.path, entry.items.length);
					break;
				case "copy_lost":
					for (const path of [...this.ends.keys()]) if (within(path, entry.path)) this.ends.delete(path);
					break;
				case "run_end":
					this.lives.push({ usage: entry.usage, partial: false });
					runEnd = entry;
					segment = [];
					start = i + 1;
					break;
			}
		}
		// Past the last end, what a life wrote before it was killed.
		const killed = start < journal.length;
		if (killed) this.lives.push({ usage: costOf(segment), partial: true });
		if (events.some(isVisit)) {
			this.lives.push({ usage: costOf(this.tell(events)), partial: false });
			start = journal.length;
		} else if (!killed) this.runEnd = runEnd;
		const point = this.lives.length > 1 ? resumePoint(checked, journal.slice(0, start)) : undefined;
		this.resumedFrom = point?.ok && point.from !== "" ? point.from : undefined;
	}

	/** Whether the visit `path` is running now. */
	live(path: string): boolean {
		return this.running.has(path);
	}

	/** How the visit `path` last ended, unless it is running again. */
	ended(path: string): VisitEnd | undefined {
		return this.running.has(path) ? undefined : this.ends.get(path);
	}

	/** Whether any visit at or inside `path` began or ended. */
	touched(path: string): boolean {
		return [...this.ends.keys(), ...this.running].some((one) => within(one, path));
	}

	/** Every visit that ended inside `prefix`, as it last did. */
	endedIn(prefix: string): VisitEnd[] {
		return [...this.ends.values()].filter((end) => within(end.path, prefix) && !this.running.has(end.path));
	}

	/** Every visit that ended, as it last did. */
	get all(): VisitEnd[] {
		return this.endedIn("");
	}

	/** The subagents spawned for the visit `path`. */
	subagents(path: string): readonly string[] {
		return this.spawned.get(path) ?? [];
	}

	/** How many items the `map` visit `path` froze, when a journal says. */
	items(path: string): number | undefined {
		return this.frozen.get(path);
	}

	/** Folds this life's `events`, and gives back the visits it ended. */
	private tell(events: readonly SubagentEvent[]): VisitEnd[] {
		const told: VisitEnd[] = [];
		for (const event of events) {
			if (event.type === "visit_start") this.running.add(event.path);
			else if (event.type === "visit_end") {
				this.running.delete(event.path);
				this.ends.set(event.path, event);
				told.push(event);
			} else if (event.type === "spawn" && event.visit !== undefined) this.spawned.set(event.visit, [...this.subagents(event.visit), event.id]);
		}
		return told;
	}
}

/**
 * What a set of ended visits cost: each counted once, at the outermost visit
 * that holds it, since a visit's usage includes every visit inside it. The
 * time adds up, for the visits it counts ran one after the other.
 */
export function costOf(ends: readonly VisitEnd[]): Usage {
	const paths = new Set(ends.map((end) => end.path));
	const outermost = ends.filter((end) => !holders(end.path).some((one) => paths.has(one)));
	const wallMs = outermost.reduce((sum, end) => sum + end.wallMs, 0);
	return sumUsage(
		outermost.map((end) => end.usage),
		wallMs,
	);
}

/** The visits that can hold the visit `path`: each segment before its last, an iteration or an item read as its loop or `map`. */
function holders(path: string): string[] {
	const segments = path.split("/");
	return segments.slice(1).map((_, i) => segments.slice(0, i + 1).join("/").replace(/(#\d+|\[\d+\])$/, ""));
}

/** Whether `key` is the visit `path` or inside it: under it, one of its iterations or one of its items. `""` holds every visit. */
function within(key: string, path: string): boolean {
	return path === "" || key === path || ["/", "#", "["].some((mark) => key.startsWith(`${path}${mark}`));
}
