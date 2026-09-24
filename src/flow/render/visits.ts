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
 * `copy_lost` forgets every end under its branch, as a resume does. What a
 * visit cost is every life's, since each one was paid for: a `copy_lost` or a
 * visit run again forgets how it ended, never what it spent.
 */

import { isVisit, type SubagentEvent } from "../../events.ts";
import { costOf, livesOf } from "../../measure/index.ts";
import { sumUsage, type Usage } from "../../usage.ts";
import type { CheckedFlow } from "../checked.ts";
import { resumePoint, type JournalEntry, type VisitEnd } from "../run/index.ts";

/** One life of a run: what it cost, whether it was killed before it could write its end, and the visits it ended. */
export type Life = { readonly usage: Usage; readonly partial: boolean; readonly ends: readonly VisitEnd[] };

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

	/** `elapsedMs`, when given, is how long this life has run: a life is running, and that is its time. */
	constructor(checked: CheckedFlow, journal: readonly JournalEntry[], events: readonly SubagentEvent[], elapsedMs?: number) {
		for (const entry of journal) {
			if (entry.type === "visit_end") this.ends.set(entry.path, entry);
			else if (entry.type === "map_items") this.frozen.set(entry.path, entry.items.length);
			else if (entry.type === "copy_lost") for (const path of [...this.ends.keys()]) if (within(path, entry.path)) this.ends.delete(path);
		}
		const lives = livesOf(journal);
		for (const life of lives) this.lives.push({ usage: life.runEnd?.usage ?? costOf(life.ends), partial: life.runEnd === undefined, ends: life.ends });
		const live = elapsedMs !== undefined || events.some(isVisit);
		if (live) {
			const told = this.tell(events);
			const usage = costOf(told);
			// The visits it ended add up to less than its time while one runs, and to more once branches ran together.
			this.lives.push({ usage: { ...usage, wallMs: elapsedMs ?? usage.wallMs }, partial: false, ends: told });
		}
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

	/** What every life spent at or inside `path`: the outermost visits each one ended there, added up. */
	spent(path: string): Usage {
		const each = this.lives.map((life) => costOf(life.ends.filter((end) => within(end.path, path))));
		return sumUsage(each, each.reduce((sum, one) => sum + one.wallMs, 0));
	}

	/** Every visit that ended, as it last did. */
	get all(): VisitEnd[] {
		return [...this.ends.values()].filter((end) => !this.running.has(end.path));
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
