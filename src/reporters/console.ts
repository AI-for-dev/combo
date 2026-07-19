/**
 * A plain console reporter: one line per event that matters.
 *
 * Deliberately dumb - it is the proof that the event stream carries enough on
 * its own, before any TUI or herdr integration gets involved.
 */

import type { EventListener } from "../events.ts";
import { formatUsage } from "../usage.ts";

export type ConsoleReporterOptions = {
	/** Where to write. Defaults to `console.log`, but tests pass a recorder. */
	write?: (line: string) => void;
	/** Show streamed assistant text as it arrives. Off by default: it is noisy. */
	text?: boolean;
};

/** Builds a console reporter. */
export function consoleReporter(options: ConsoleReporterOptions = {}): EventListener {
	const write = options.write ?? ((line: string) => console.log(line));

	return (event) => {
		switch (event.type) {
			case "spawn":
				write(`\n⏳ ${event.id}  (lifetime: ${event.lifetime})`);
				break;
			case "tool":
				write(`   · ${event.id} → ${event.name}`);
				break;
			case "text":
				if (options.text) write(event.delta);
				break;
			case "usage":
				write(`   ${event.id}  ${formatUsage(event.usage)}`);
				break;
			case "close":
				write(`✓ ${event.id}  ${formatUsage(event.result.usage)}`);
				break;
			case "status":
				break;
		}
	};
}
