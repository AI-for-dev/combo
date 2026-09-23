/**
 * What a resume keeps of a run's journal, as the walk asks for it: each
 * visit that ended and survives, each `carry` and frozen `map` list, each
 * ledger's obligations, each copy, and the run's branch.
 *
 * A visit survives when it ended with a value the flow read on: `ok`, or
 * failed under `on-fail: continue`. One stopped or cut from above ran to no
 * end of its own, and a failure that travelled up was the run's: both run
 * again, which is how a failed run replays its failure chain, each visit
 * with a fresh `retry:` budget. A resume appends to the same journal, so the
 * last entry of a path is the one that counts, and a `copy_lost` forgets
 * every fact under its branch written before it.
 */

import type { Obligation } from "../../review/index.ts";
import type { CheckedFlow } from "../checked.ts";
import type { Ended } from "./ended.ts";
import type { JournalEntry, VisitEnd } from "./journal.ts";
import { nodeAt } from "./keys.ts";

/** A copy the journal left open: where it is, its git branch and its base; none of them in a dry run. */
export type OpenCopy = { readonly dir?: string; readonly branch?: string; readonly base?: string };

/** What the journal says of a branch's copy: still open, or landed, its work in the tree or not. */
export type CopyState = { readonly open: OpenCopy } | { readonly landed: boolean };

type Written = Extract<JournalEntry, { type: "obligation_raised" | "obligation_closed" }>;

/** A run's journal, folded for a resume. Only `Replay.of` makes one. */
export class Replay {
	private readonly survivors = new Map<string, Ended>();
	/** Every visit that ended, surviving or not: where the run has been. */
	private readonly seen = new Set<string>();
	private readonly carries = new Map<string, unknown>();
	private readonly lists = new Map<string, readonly unknown[]>();
	private readonly copies = new Map<string, CopyState>();
	private obligationsWritten: Written[] = [];
	private runBranch: string | undefined;
	private last: Extract<JournalEntry, { type: "run_end" }> | undefined;

	private constructor() {}

	/** `journal` folded against `flow`, or the first visit it names that `flow` has not. */
	static of(flow: CheckedFlow, journal: readonly JournalEntry[]): Replay | string {
		const replay = new Replay();
		for (const entry of journal) {
			const unknown = replay.fold(flow, entry);
			if (unknown !== undefined) return unknown;
		}
		return replay;
	}

	/** How the run last ended, when an earlier process saw it end. */
	get runEnd(): Extract<JournalEntry, { type: "run_end" }> | undefined {
		return this.last;
	}

	/** The run's branch, once its first commit opened it. */
	get branch(): string | undefined {
		return this.runBranch;
	}

	/** How the visit `path` ended, when it survives. */
	ended(path: string): Ended | undefined {
		return this.survivors.get(path);
	}

	/** Whether any visit at or under `path` ended. */
	touched(path: string): boolean {
		return [...this.seen].some((one) => within(one, path) || one.startsWith(`${path}#`) || one.startsWith(`${path}[`));
	}

	/** The `carry` the iteration `path` read. */
	carry(path: string): { readonly ok: true; readonly value: unknown } | undefined {
		return this.carries.has(path) ? { ok: true, value: this.carries.get(path) } : undefined;
	}

	/** The list the `map` visit `path` froze. */
	items(path: string): readonly unknown[] | undefined {
		return this.lists.get(path);
	}

	/** The obligations of the ledger kept at `at`, as the visits that survive left them. */
	obligations(at: string): Obligation[] {
		const kept = new Map<string, Obligation>();
		for (const entry of this.obligationsWritten) {
			if (entry.ledger !== at || this.survivors.get(entry.visit)?.ok !== true) continue;
			if (entry.type === "obligation_raised") kept.set(entry.obligation.id, { ...entry.obligation });
			else {
				const one = kept.get(entry.id);
				if (one !== undefined) one.closed = entry.closure;
			}
		}
		return [...kept.values()];
	}

	/** What the journal says of the copy of the branch `path`. */
	copy(path: string): CopyState | undefined {
		return this.copies.get(path);
	}

	/** Forgets every fact at or under the branch `path`: its copy was lost, so it starts over. */
	forget(path: string): void {
		for (const map of [this.survivors, this.carries, this.lists, this.copies]) {
			for (const key of [...map.keys()]) if (within(key, path)) map.delete(key);
		}
		for (const key of [...this.seen]) if (within(key, path)) this.seen.delete(key);
		this.obligationsWritten = this.obligationsWritten.filter((entry) => !within(entry.visit, path));
	}

	private fold(flow: CheckedFlow, entry: JournalEntry): string | undefined {
		switch (entry.type) {
			case "visit_end": {
				const found = nodeAt(flow.nodes, entry.path);
				if ("code" in found) return entry.path;
				this.seen.add(entry.path);
				const ended = survives(entry, found.node.continueOnFail);
				if (ended === undefined) this.survivors.delete(entry.path);
				else this.survivors.set(entry.path, ended);
				return undefined;
			}
			case "carry":
				this.carries.set(entry.path, entry.value);
				return undefined;
			case "map_items":
				this.lists.set(entry.path, entry.items);
				return undefined;
			case "obligation_raised":
			case "obligation_closed":
				this.obligationsWritten.push(entry);
				return undefined;
			case "copy_opened":
				this.copies.set(entry.path, { open: { dir: entry.dir, branch: entry.branch, base: entry.base } });
				return undefined;
			case "copy_landed":
				this.copies.set(entry.path, { landed: entry.landed });
				return undefined;
			case "copy_lost":
				this.forget(entry.path);
				return undefined;
			case "branch_opened":
				this.runBranch = entry.branch;
				return undefined;
			case "run_end":
				this.last = entry;
				return undefined;
		}
	}
}

/** How `end` reads to the flow on a resume, when it survives. */
function survives(end: VisitEnd, continueOnFail: boolean): Ended | undefined {
	if (end.ok) return { ok: true, output: end.output };
	const error = end.error as NonNullable<VisitEnd["error"]>;
	if (!continueOnFail || error.kind === "stopped" || error.kind === "cancelled") return undefined;
	return { ok: false, error };
}

/** Whether `key` is `path` or under it. */
function within(key: string, path: string): boolean {
	return key === path || key.startsWith(`${path}/`);
}
