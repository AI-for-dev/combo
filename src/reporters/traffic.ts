/**
 * How what passes between members reads, in one place.
 *
 * Three events carry a board: a member posted, a member was handed what it had
 * not seen, a member asked for something and was granted it or refused. Two
 * displays draw them - the console, and a herdr pane - and a run is compared
 * against another run by reading them, so the two have to say the same thing in
 * the same words. Written twice they drift, and the drift is only ever noticed
 * by whoever is trying to compare.
 *
 * The **quiet one is why this exists at all**: a member handed nothing is what
 * tells three members racing apart from three models thinking alike.
 */

import type { SubagentEvent } from "../events.ts";
import { plural, truncate } from "../text.ts";

/** How much of a post a line shows before the rest is somebody else's problem. */
const SAID = 60;

/** Whose pane this is, when the line is drawn somewhere that already knows. */
export type TrafficOptions = {
	/**
	 * The member this line is being shown to.
	 *
	 * Its own name is dropped when it matches: a pane headed `member#2` saying
	 * `member#2` on every line spends width on what the header already said. The
	 * board's own pane passes nothing, because there the author is the point.
	 */
	self?: string;
};

/**
 * One line for a board event, or `undefined` for everything else.
 *
 * `undefined` rather than an empty string: a caller writes a line or does not,
 * and an empty one is a blank row in a pane nobody asked for.
 */
export function trafficLine(event: SubagentEvent, options: TrafficOptions = {}): string | undefined {
	const who = (id: string) => (id === options.self ? "" : ` ${id}`);

	switch (event.type) {
		case "post": {
			const to = event.post.to ? ` → ${event.post.to}` : "";
			const re = event.post.re ? ` re ${event.post.re.id} (${event.post.re.from})` : "";
			return `✉${who(event.id)}${to}${re} [${event.post.kind}] ${truncate(event.post.text, SAID)}`;
		}
		case "read":
			return `⇣${who(event.id)} was handed ${handed(event.posts.length, event.waiting)}`;
		case "claim":
			return `⚑${who(event.id)} ${event.action} ${event.key} → ${settled(event.action, event.ok, event.heldBy)}`;
		default:
			return undefined;
	}
}

/** `nothing`, or how much and how much is still waiting. */
function handed(count: number, waiting: number): string {
	if (count === 0) return "nothing";
	return `${plural(count, "post")}${waiting > 0 ? `, ${waiting} waiting` : ""}`;
}

/**
 * What became of a take or a release.
 *
 * A refusal names the holder when there is one, because that is the fact a
 * reader of the run is after: contention has somebody in it, and "refused"
 * alone cannot tell it from asking for something that was never there.
 */
function settled(action: "take" | "release", ok: boolean, heldBy?: string): string {
	if (ok) return action === "take" ? "granted" : "given back";
	return heldBy ? `refused (${heldBy})` : "refused";
}
