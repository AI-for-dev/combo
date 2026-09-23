/**
 * The journal of a run: one JSON line per fact, appended when it happens and
 * never rewritten, which is what a resume and the live view read back.
 *
 * The runner writes it through a port, never a reporter: unplug every
 * reporter and the journal is the same. A real run given a run directory
 * appends to `journal.jsonl` there; one given none writes nowhere; a dry run
 * keeps the entries in an array it hands back. A fact is written once it no
 * longer changes, so branches running together only ever add a line.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VisitEvent } from "../../events.ts";
import { createLedger, type Closure, type Ledger, type Obligation } from "../../review/index.ts";
import type { Usage } from "../../usage.ts";
import type { FlowError } from "../checked.ts";

/** Where the journal is, in a run directory. */
export const JOURNAL_FILE = "journal.jsonl";

/** Every kind of fact the journal holds, as its entries' `type`. */
export const ENTRY_TYPES = ["visit_end", "carry", "map_items", "obligation_raised", "obligation_closed", "copy_opened", "copy_landed", "copy_lost", "branch_opened", "run_end"] as const;

/** A visit that ended: its `visit_end`, written down. */
export type VisitEnd = Extract<VisitEvent, { type: "visit_end" }>;

/** One fact of a run. A path is a visit's, `deliver#2/work[1]/review`. */
export type JournalEntry =
	| VisitEnd
	/** The `carry` the iteration `path`, `review#2`, reads. */
	| { readonly type: "carry"; readonly path: string; readonly value: unknown }
	/** The list the `map` visit `path` runs over, frozen when it starts. */
	| { readonly type: "map_items"; readonly path: string; readonly items: readonly unknown[] }
	/** An obligation the `verdict:` visit `visit` raised in the ledger of the scope opened at the visit `ledger`: a loop's, or a `map` item's. */
	| { readonly type: "obligation_raised"; readonly ledger: string; readonly visit: string; readonly obligation: Obligation }
	| { readonly type: "obligation_closed"; readonly ledger: string; readonly visit: string; readonly id: string; readonly closure: Closure }
	/** The copy the branch `path` runs in: its directory, git branch and the commit it started from, none in a dry run, which makes no copy. */
	| { readonly type: "copy_opened"; readonly path: string; readonly dir?: string; readonly branch?: string; readonly base?: string }
	/** What landing the branch `path`'s patch gave, once every branch of its block ended. */
	| { readonly type: "copy_landed"; readonly path: string; readonly landed: boolean; readonly refused?: string }
	/** A resume found the copy of the branch `path` gone, or its work not landed: every fact under it before this line is forgotten, and it starts over. */
	| { readonly type: "copy_lost"; readonly path: string; readonly why: string }
	/** The run's own branch, opened by its first commit. */
	| { readonly type: "branch_opened"; readonly branch: string }
	/** How the run ended: what `runFlow` returned, written down. */
	| { readonly type: "run_end"; readonly ok: boolean; readonly output?: unknown; readonly error?: FlowError; readonly path?: string; readonly usage: Usage };

/** Where the runner writes each fact. */
export type Journal = { append(entry: JournalEntry): void };

/** The journal of a run given no run directory: nothing touches the disk. */
export const NO_JOURNAL: Journal = { append() {} };

/**
 * The journal in `runDir`. Each fact is one synchronous append, so it is on
 * disk before the run goes on, and a line is never interleaved with another.
 */
export function fileJournal(runDir: string): Journal {
	const file = join(runDir, JOURNAL_FILE);
	return { append: (entry) => appendFileSync(file, `${JSON.stringify(entry)}\n`) };
}

/**
 * The journal in `runDir`, in the order it was written; none when the run
 * wrote nothing. A line a crash cut short can only be the last, and it is
 * ignored. Any other line that is not an entry throws: the file was not
 * written by a run.
 */
export function readJournal(runDir: string): JournalEntry[] {
	const file = join(runDir, JOURNAL_FILE);
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	// Each entry ends with its newline: whatever follows the last one is torn.
	return text
		.split("\n")
		.slice(0, -1)
		.map((line, i) => entry(line, `${file}:${i + 1}`));
}

function entry(line: string, where: string): JournalEntry {
	let parsed: { type?: unknown } | undefined;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`${where} is not JSON: ${line.slice(0, 80)}`);
	}
	if (!(ENTRY_TYPES as readonly unknown[]).includes(parsed?.type)) throw new Error(`${where} is not a journal entry: ${line.slice(0, 80)}`);
	return parsed as JournalEntry;
}

/** The ledger a scope keeps, and how one visit writes to it. */
export type KeptLedger = {
	/** What `<scope>.ledger` reads, and a `verdict:` turn is shown. */
	readonly ledger: Ledger;
	/** The ledger as the visit `visit` writes to it: each raise and each accepted close written down with the visit that made it. */
	by(visit: string): Ledger;
};

/**
 * The ledger of the scope opened at the visit `at`, carrying on from
 * `restored`, what a resume kept of it. A close the ledger refuses changed
 * nothing, and writes nothing.
 */
export function journaledLedger(journal: Journal, at: string, restored: readonly Obligation[] = []): KeptLedger {
	const ledger = createLedger(restored);
	return {
		ledger,
		by: (visit) => ({
			raise(openedBy, text, round) {
				const obligation = ledger.raise(openedBy, text, round);
				journal.append({ type: "obligation_raised", ledger: at, visit, obligation: { ...obligation } });
				return obligation;
			},
			close(id, by, closure) {
				const outcome = ledger.close(id, by, closure);
				if (outcome.ok) journal.append({ type: "obligation_closed", ledger: at, visit, id, closure: outcome.obligation.closed as Closure });
				return outcome;
			},
			get all() {
				return ledger.all;
			},
			get open() {
				return ledger.open;
			},
			get settled() {
				return ledger.settled;
			},
		}),
	};
}
