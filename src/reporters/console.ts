/**
 * A plain console reporter: one line per event that matters.
 *
 * Deliberately dumb - it is the proof that the event stream carries enough on
 * its own, before any TUI or herdr integration gets involved.
 */

import type { EventListener } from "../events.ts";
import { plural, truncate } from "../text.ts";
import { formatUsage } from "../usage.ts";

/** How much the console reporter says, and where it says it. */
export type ConsoleReporterOptions = {
	/** Where to write. Defaults to `console.log`, but tests pass a recorder. */
	write?: (line: string) => void;
	/** Show streamed assistant text as it arrives. Off by default: it is noisy. */
	text?: boolean;
};

/** Builds a console reporter. */
export function consoleReporter(options: ConsoleReporterOptions = {}): EventListener {
	const write = options.write ?? ((line: string) => console.log(line));
	// The one thing this reporter remembers, and it earns it: a delegated
	// subagent reads as a delegated subagent only if it is under the one that
	// asked for it. The stream says so on `spawn`, once.
	const depths = new Map<string, number>();
	const indent = (id: string) => "  ".repeat(depths.get(id) ?? 0);

	return (event) => {
		switch (event.type) {
			case "spawn": {
				const depth = event.parentId ? (depths.get(event.parentId) ?? 0) + 1 : 0;
				depths.set(event.id, depth);
				write(`\n${indent(event.id)}⏳ ${event.id}  (lifetime: ${event.lifetime})`);
				break;
			}
			case "tool":
				write(`${indent(event.id)}   · ${event.id} → ${event.name}`);
				break;
			case "text":
				if (options.text) write(event.delta);
				break;
			case "post": {
				const to = event.post.to ? ` → ${event.post.to}` : "";
				write(`${indent(event.id)}   ✉ ${event.id}${to} [${event.post.kind}] ${truncate(event.post.text, 60)}`);
				break;
			}
			// What a member said is in the posts; what it knew when it said so is
			// only here. A member handed nothing is what tells three members racing
			// apart from three models thinking alike.
			case "read":
				write(`${indent(event.id)}   ⇣ ${event.id} was handed ${handed(event.posts.length, event.waiting)}`);
				break;
			case "claim":
				write(`${indent(event.id)}   ⚑ ${event.id} ${event.action} ${event.key} → ${settled(event.action, event.ok, event.heldBy)}`);
				break;
			case "usage":
				write(`${indent(event.id)}   ${event.id}  ${formatUsage(event.usage)}`);
				break;
			case "close":
				write(`${indent(event.id)}✓ ${event.id}  ${formatUsage(event.result.usage)}`);
				break;
			case "status":
				break;
		}
	};
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
