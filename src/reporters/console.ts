/**
 * A plain console reporter: one line per event that matters.
 *
 * Deliberately dumb - it is the proof that the event stream carries enough on
 * its own, before any TUI or herdr integration gets involved.
 */

import type { EventListener } from "../events.ts";
import { formatUsage } from "../usage.ts";
import { createRunPicture } from "./picture.ts";
import { trafficLine } from "./traffic.ts";
import { statusIcon } from "./tui.ts";

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
	// This reporter remembers nothing of its own. The one thing it needs beyond
	// the event in hand - how deep a delegated subagent sits - is the picture's
	// to know, and it is read from there.
	const picture = createRunPicture();
	const indent = (id: string) => "  ".repeat(picture.of(id)?.depth ?? 0);

	return (event) => {
		picture.reporter(event);
		switch (event.type) {
			case "spawn":
				write(`\n${indent(event.id)}⏳ ${event.id}  (lifetime: ${event.lifetime})`);
				break;
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
				write(`${indent(event.id)}${statusIcon(event.result.ok ? "done" : "failed")} ${event.id}  ${formatUsage(event.result.usage)}`);
				break;
			case "status":
				break;
		}
	};
}
