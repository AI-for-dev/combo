/**
 * The one line a flow run collapses to: how it stands, and counts that hide
 * nothing.
 */

import { sumUsage, type Usage } from "../../usage.ts";
import type { Visits } from "./visits.ts";

/** A run in one line's worth of facts. */
export type LiveSummary = {
	/** `done` or `failed` once its root sequence is over, `working` while this life runs, `pending` for a life killed before its end. */
	readonly state: "pending" | "working" | "done" | "failed";
	/** Every visit that ended, as it last did. */
	readonly visits: number;
	/** Of those, the ones that ended `ok: false`, those `on-fail: continue` absorbed included. */
	readonly failed: number;
	/** The visit path of each loop that hit its cap or gave up. */
	readonly unconverged: readonly string[];
	/** What every life cost, added up: `wallMs` is their time. */
	readonly usage: Usage;
	readonly lives: number;
	/** How many lives were killed before they wrote their end, and are counted from what they did write. */
	readonly partial: number;
	/** The visit the last life picked up from, when it resumed. */
	readonly resumedFrom?: string;
};

/** The summary of the run `visits` read, `root` saying how its root sequence ended, if it did. */
export function summaryOf(visits: Visits, root: { readonly ok: boolean } | undefined): LiveSummary {
	const ends = visits.all;
	// Only a loop ends `converged: false`, and only a loop fails `unconverged`: a failure travelling up is `child`.
	const unconverged = ends.filter((end) => end.converged === false || end.error?.kind === "unconverged");
	const { lives, runEnd, resumedFrom } = visits;
	const over = runEnd ?? root;
	return {
		state: over !== undefined ? (over.ok ? "done" : "failed") : lives.at(-1)?.partial === false ? "working" : "pending",
		visits: ends.length,
		failed: ends.filter((end) => !end.ok).length,
		unconverged: unconverged.map((end) => end.path),
		usage: sumUsage(
			lives.map((life) => life.usage),
			lives.reduce((sum, life) => sum + life.usage.wallMs, 0),
		),
		lives: lives.length,
		partial: lives.filter((life) => life.partial).length,
		...(resumedFrom !== undefined && { resumedFrom }),
	};
}
