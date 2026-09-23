/**
 * What a run's journal and its event stream say of its visits, read once for
 * the live view: how each visit last ended, which are running now, the
 * subagents each spawned, and the lives the run has had.
 *
 * The journal holds what earlier lives wrote and the events what this one
 * told, so one reading takes a finished run's journal alone, a live run's
 * stream alone, or a resume's journal and stream together. Each life of the
 * journal opens with its `life_start`, and one with no `run_end` was killed.
 * A visit's last end is the one the frame draws, whichever life wrote it; a
 * `copy_lost` forgets every end under its branch, as a resume does.
 */

import { isVisit, type SubagentEvent } from "../../events.ts";
import { costOf, livesOf } from "../../measure/index.ts";
import type { Usage } from "../../usage.ts";
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
		for (const entry of journal) {
			if (entry.type === "visit_end") this.ends.set(entry.path, entry);
			else if (entry.type === "map_items") this.frozen.set(entry.path, entry.items.length);
			else if (entry.type === "copy_lost") for (const path of [...this.ends.keys()]) if (within(path, entry.path)) this.ends.delete(path);
		}
		const lives = livesOf(journal);
		for (const life of lives) this.lives.push({ usage: life.runEnd?.usage ?? costOf(life.ends), partial: life.runEnd === undefined });
		const live = events.some(isVisit);
		if (live) this.lives.push({ usage: costOf(this.tell(events)), partial: false });
		this.runEnd = live ? undefined : lives.at(-1)?.runEnd;
		// The last life picked up where the journal before it left off.
		const before = live ? journal : journal.slice(0, Math.max(0, journal.findLastIndex((entry) => entry.type === "life_start")));
		const point = this.lives.length > 1 ? resumePoint(checked, before) : undefined;
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

/** Whether `key` is the visit `path` or inside it: under it, one of its iterations or one of its items. `""` holds every visit. */
function within(key: string, path: string): boolean {
	return path === "" || key === path || ["/", "#", "["].some((mark) => key.startsWith(`${path}${mark}`));
}
