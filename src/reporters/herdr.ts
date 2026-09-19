/**
 * The herdr reporter: one split per subagent, showing it work.
 *
 * The trick worth knowing: a herdr pane cannot *host* an in-process subagent -
 * there is no process and no TTY to attach. So the pane does not host it, it
 * **displays a stream we write**. We append to a file and open a pane running
 * `tail -f` on it. The pane is then ours, which is also why we can report agent
 * state on it: the main pane's state already belongs to herdr's own pi
 * integration, and two sources cannot own one pane.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EventListener, SubagentEvent, SubagentStatus } from "../events.ts";
import { plural, scalar, truncate } from "../text.ts";
import { formatUsage } from "../usage.ts";
import { trafficLine } from "./traffic.ts";
import { createHerdrSend, detectHerdr, HERDR_SOURCE, nextSeq, paneIdOf, type HerdrSend } from "./herdr-client.ts";

/** The name of the pane the members talk on. Not an agent: nobody works in it. */
export const BOARD_PANE = "board";

/** How the herdr reporter behaves: where splits open, and for whom. */
export type HerdrOptions = {
	/** Where the split opens. Defaults to `"right"`. */
	split?: "right" | "down";
	/** Steal focus when a split opens. Defaults to `false` - you are still typing. */
	focus?: boolean;
	/** Transport. Injection point for tests; defaults to the real socket. */
	send?: HerdrSend;
	/** Directory for the live logs. Defaults to a per-run temp directory. */
	dir?: string;
	/**
	 * Told once what became of the first split this run asked for.
	 *
	 * Every herdr call is fire-and-forget with an empty `catch`, because a
	 * display problem is never a workflow problem. That is right for the run and
	 * wrong for the person watching: asked for a split and given nothing, they
	 * see an ordinary run and no reason. Measured, on a real herdr with all three
	 * markers set: no pane opened, nothing said, and the cause was only
	 * reachable by reading this file. One line, once, whichever way it went.
	 */
	notify?: (message: string, level: "info" | "warning") => void;
	/**
	 * Open a split for **every** subagent, whatever each one asked for.
	 *
	 * `openInHerdr` is opt-in per subagent so a fan-out of twenty branches
	 * cannot carpet the screen by accident. This is the other regime, asked for
	 * explicitly: watch everything. It belongs to the reporter and not to the
	 * core, because "who gets a pane" is a display decision - the workflow runs
	 * identically either way.
	 *
	 * Off unless asked for. `/herdr on` is the session-wide switch inside pi.
	 */
	all?: boolean;
};

/**
 * Builds the herdr reporter, or `undefined` when herdr is not there.
 *
 * `undefined` is the whole fallback protocol: the caller drops to another
 * reporter without an error and without a warning. Nobody wants a message
 * telling them herdr is not running when they never asked for herdr.
 */
export function createHerdrReporter(options: HerdrOptions = {}): EventListener | undefined {
	const send = options.send ?? bindSocket();
	if (!send) return undefined;
	return createHerdrReporterWith(send, options);
}

/** The reporter proper, with the transport already chosen. Exported for tests. */
export function createHerdrReporterWith(send: HerdrSend, options: HerdrOptions = {}): EventListener {
	const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "combo-"));
	fs.mkdirSync(dir, { recursive: true });
	const all = options.all ?? false;

	const panes = new Map<string, Pane>();
	// Once per run, not once per subagent: three members that all failed to open
	// have one cause between them, and three copies of it is noise.
	let told = false;
	const tell = (message: string, level: "info" | "warning") => {
		if (told) return;
		told = true;
		try {
			options.notify?.(message, level);
		} catch {
			// a display problem is never a workflow problem, this one included
		}
	};
	// The board is a pane of the **run**, not of a member: what one said is in
	// its own pane, and who it was talking to is only legible where all of them
	// are. Opened on the first thing anybody says, so a run with no board never
	// grows a window for one.
	let board: Pane | undefined;
	let lines = 0;

	return (event) => {
		// A reporter must never throw into the bus, and never make the caller
		// wait: every herdr call is fire-and-forget.
		try {
			handle(event);
		} catch {
			// a display problem is never a workflow problem
		}
	};

	function handle(event: SubagentEvent) {
		if (event.type === "spawn") {
			// Opt-in per subagent, unless the whole run was asked to be watched.
			if (!event.openInHerdr && !all) return;
			panes.set(event.id, openPane(send, dir, event.id, options, tell));
			return;
		}

		const traffic = trafficLine(event);
		if (traffic !== undefined) {
			lines += 1;
			boardPane()?.write(`${traffic}\n`);
			// The same line in the member's own pane, without its own name: the
			// header above it already says who this is.
			panes.get(event.id)?.write(`${trafficLine(event, { self: event.id })}\n`);
			return;
		}

		const pane = panes.get(event.id);
		if (!pane) return; // a subagent that did not ask for a split

		switch (event.type) {
			case "tool":
				pane.write(`$ ${event.name}${formatArgs(event.args)}\n`);
				break;
			case "text":
				pane.write(event.delta);
				break;
			case "status":
				pane.report(event.status);
				break;
			case "usage":
				pane.write(`\n${formatUsage(event.usage)}\n`);
				break;
			case "close":
				panes.delete(event.id);
				pane.finish(formatUsage(event.result.usage));
				// The board goes when the last member does: it belongs to the run,
				// and a pane left behind is one the next run opens beside.
				if (panes.size === 0 && board) {
					board.finish(`${plural(lines, "line")} between them`);
					board = undefined;
				}
				break;
		}
	}

	/** The board's pane, opened on demand - and only when this run is watched. */
	function boardPane(): Pane | undefined {
		// Nobody watching any member is nobody watching the run: a board pane on
		// its own would be a window that was never asked for.
		if (!board && (all || panes.size > 0)) board = openPane(send, dir, BOARD_PANE, options, tell);
		return board;
	}
}

type Pane = {
	write(text: string): void;
	report(status: SubagentStatus): void;
	finish(usageLine: string): void;
};

/**
 * Opens one split and returns the handle used to feed it.
 *
 * `agent.start` is asynchronous, but events arrive immediately: everything is
 * queued behind the pending pane id, so nothing is lost and nothing blocks.
 */
function openPane(
	send: HerdrSend,
	dir: string,
	id: string,
	options: HerdrOptions,
	tell: (message: string, level: "info" | "warning") => void,
): Pane {
	const logPath = path.join(dir, `${id.replace(/[^\w.#-]/g, "_")}.log`);
	// Only a pane that had an agent reported on it has one to release. The board
	// is a pane and not an agent, and releasing one herdr never heard of is a
	// call that can only go wrong.
	let reported = false;
	fs.writeFileSync(logPath, `${id}\n\n`);

	// Writes are appended synchronously and in order. Interleaved async appends
	// would scramble a token stream, which is precisely what we are displaying.
	const write = (text: string) => {
		try {
			fs.appendFileSync(logPath, text);
		} catch {
			// the pane may already be gone; that is not a workflow error
		}
	};

	// `tail -f` follows the file we just created. `-n +1` shows it from the top,
	// so the agent name written above is visible.
	//
	// Every chain below ends in a `catch`. "Never throws" is not enough for an
	// observer: an unhandled rejection escapes the try/catch around the listener
	// entirely, and in Node it takes the whole process down.
	const started = send("agent.start", {
		name: id,
		argv: ["tail", "-n", "+1", "-f", logPath],
		split: options.split ?? "right",
		focus: options.focus ?? false,
	})
		.then((answer) => {
			const paneId = paneIdOf(answer);
			// What herdr said, verbatim and short: "method not found" and "no
			// answer at all" are different problems with the same symptom, and
			// only the server can tell them apart.
			if (paneId) tell(`herdr: splits are opening - ${id} is in pane ${paneId}`, "info");
			else tell(`herdr: no split opened for ${id} - agent.start answered ${said(answer)}`, "warning");
			return paneId;
		})
		.catch(() => undefined);

	const onPane = (fn: (paneId: string) => Promise<unknown> | void) => {
		void started
			.then((paneId) => (paneId ? fn(paneId) : undefined))
			.catch(() => undefined);
	};

	return {
		write,

		report(status) {
			reported = true;
			onPane((paneId) =>
				send("pane.report_agent", {
					pane_id: paneId,
					source: HERDR_SOURCE,
					agent: id,
					// herdr's PaneAgentState has no "done": it is idle | working |
					// blocked | unknown. A finished subagent reads as idle, and the
					// release below is what actually retires it.
					state: status === "done" ? "idle" : status,
					seq: nextSeq(),
				}),
			);
		},

		finish(usageLine) {
			write(`\n--\n${usageLine}\n`);
			onPane((paneId) =>
				(reported
					? send("pane.release_agent", { pane_id: paneId, source: HERDR_SOURCE, agent: id, seq: nextSeq() })
					: Promise.resolve(undefined))
					// Close after the release, not in parallel: closing first would
					// leave herdr holding an agent on a pane that no longer exists.
					.then(() => send("pane.close", { pane_id: paneId }))
					.then(() => {
						try {
							fs.rmSync(logPath, { force: true });
						} catch {
							// best effort; the temp directory goes away anyway
						}
					}),
			);
		},
	};
}

/** What came back, short enough for one line. `HerdrSend` gives `undefined` when nothing did. */
function said(answer: unknown): string {
	if (answer === undefined) return "nothing - the socket did not answer";
	try {
		return truncate(JSON.stringify(answer), 120);
	} catch {
		return "something that is not JSON";
	}
}

/** Real transport, or `undefined` when the environment says we are not in herdr. */
function bindSocket(): HerdrSend | undefined {
	const env = detectHerdr();
	return env ? createHerdrSend(env) : undefined;
}

/** A one-line hint of what a tool was called with. The pane is narrow. */
function formatArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const summary = Object.entries(args as Record<string, unknown>)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${key}=${truncate(scalar(value), 40)}`)
		.join(" ");
	return summary ? ` ${summary}` : "";
}
