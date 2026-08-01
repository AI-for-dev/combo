/**
 * The event stream, on disk: one JSON object per line, in the order it happened.
 *
 * pi's own JSONL already holds each subagent's transcript, one file each. What
 * this adds is the two things that live between them: the **interleaving** - who
 * was working while who else was reading - and **our timestamps**, since pi has
 * no notion of the wall clock a workflow runs on.
 *
 * Written with `appendFileSync`, deliberately. It is one syscall per event and a
 * streamed reply produces a great many of them, but the run worth reading
 * afterwards is the one that was interrupted, and a buffered stream loses its
 * tail exactly then. Durability over throughput, the same trade the export made.
 */

import fs from "node:fs";
import path from "node:path";
import type { EventListener } from "../events.ts";

/**
 * Appends every event to `file` as `{"ts": <ISO 8601>, …event}`.
 *
 * The events are recorded **verbatim** - no filtering, no summarising. A
 * recorder that edits its own record is worse than a large file, and the
 * analysis this exists for is the one nobody planned in advance.
 *
 * Every failure is swallowed, including the one that creates the directory: a
 * reporter is an observer, and an observer that takes the workflow down with it
 * is a bug.
 */
export function recordReporter(file: string): EventListener {
	let ready = false;

	return (event) => {
		try {
			if (!ready) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				ready = true;
			}
			fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
		} catch {
			// an observer's failure is never the workflow's
		}
	};
}
