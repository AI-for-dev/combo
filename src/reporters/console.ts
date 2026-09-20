/**
 * A plain console reporter: one line per event that matters.
 *
 * Deliberately dumb - it is the proof that the event stream carries enough on
 * its own, before any TUI or herdr integration gets involved.
 */

import type { EventListener } from "../events.ts";
import { formatUsage } from "../usage.ts";
import { trafficLine } from "./traffic.ts";

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
			// Everything that passed between members, in the vocabulary the herdr
			// panes use: two displays of one run have to be comparable.
			case "post":
			case "read":
			case "claim":
				write(`${indent(event.id)}   ${trafficLine(event)}`);
				break;
			// A person's word to a working subagent. Not board traffic: the pane
			// it was typed in draws it as pi draws a user message.
			case "steer":
				write(`${indent(event.id)}   ⌨ ${event.id} ← ${event.text}`);
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
