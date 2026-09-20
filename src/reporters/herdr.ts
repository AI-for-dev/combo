/**
 * The herdr reporter: one split per subagent, showing it work.
 *
 * The trick worth knowing: a herdr pane cannot *host* an in-process subagent -
 * there is no process and no TTY to attach. So the pane does not host it, it
 * **displays a stream we write**. We append to a file and open a pane running
 * `tail -f` on it. The pane is then ours, which is also why we can report agent
 * state on it: the main pane's state already belongs to herdr's own pi
 * integration, and two sources cannot own one pane.
 *
 * That takes three calls, because herdr has none that does all three:
 * `pane.split` makes the pane and hands back its id, `pane.rename` puts the
 * subagent's name on it, and `pane.send_input` types the command into the shell
 * the split started. `agent.start` sounds like the call that opens one and is
 * not: it puts a *recognised* agent into a pane that already exists.
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
	/**
	 * The pane ours open beside. Defaults to the one pi was launched in.
	 *
	 * Named rather than left out: with no target herdr splits whichever pane is
	 * focused, and that can belong to another client, or to the user reading
	 * something else in the next tab.
	 */
	pane?: string;
	/** Steal focus when a split opens. Defaults to `false` - you are still typing. */
	focus?: boolean;
	/** Transport. Injection point for tests; defaults to the real socket. */
	send?: HerdrSend;
	/** Directory for the live logs. Defaults to a per-run temp directory. */
	dir?: string;
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
	if (options.send) return createHerdrReporterWith(options.send, options);
	const env = detectHerdr();
	if (!env) return undefined;
	// The pane pi is in is where the splits belong, and an explicit `pane` still wins.
	return createHerdrReporterWith(createHerdrSend(env), { pane: env.paneId, ...options });
}

/** The reporter proper, with the transport already chosen. Exported for tests. */
export function createHerdrReporterWith(send: HerdrSend, options: HerdrOptions = {}): EventListener {
	const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "combo-"));
	fs.mkdirSync(dir, { recursive: true });
	const all = options.all ?? false;

	const panes = new Map<string, Pane>();
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
			panes.set(event.id, openPane(send, dir, event.id, options));
			return;
		}

		// A person's word to one member is that member's alone: the board is what
		// passed between members, and a steer on it would open one for a run that
		// never had a board.
		if (event.type === "steer") {
			panes.get(event.id)?.write(`${trafficLine(event, { self: event.id })}\n`);
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
		if (!board && (all || panes.size > 0)) board = openPane(send, dir, BOARD_PANE, options);
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
function openPane(send: HerdrSend, dir: string, id: string, options: HerdrOptions): Pane {
	const logPath = path.join(dir, `${id.replace(/[^\w.#-]/g, "_")}.log`);
	// Only a pane that had an agent reported on it has one to release. The board
	// is a pane and not an agent, and releasing one herdr never heard of is a
	// call that can only go wrong.
	let reported = false;
	// The name, over a cleared screen. The clear belongs to the stream and not
	// to the command, because the shell that runs the command is still starting
	// up and writes over anything the command printed before it finished -
	// measured, as a zsh history warning sitting on top of a member's first turn.
	fs.writeFileSync(logPath, `\u001b[2J\u001b[H${id}\n\n`);

	// Writes are appended synchronously and in order. Interleaved async appends
	// would scramble a token stream, which is precisely what we are displaying.
	const write = (text: string) => {
		try {
			fs.appendFileSync(logPath, text);
		} catch {
			// the pane may already be gone; that is not a workflow error
		}
	};

	// Split, then type the command into the shell the split started - herdr
	// opens a pane at a prompt, it does not open one running a command.
	//
	// Every chain below ends in a `catch`. "Never throws" is not enough for an
	// observer: an unhandled rejection escapes the try/catch around the listener
	// entirely, and in Node it takes the whole process down.
	const started = (async () => {
		const paneId = paneIdOf(await send("pane.split", splitParams(options)));
		if (!paneId) return undefined;
		// A split is an anonymous shell. The name is how three member panes are
		// told apart, and the board's is the only thing saying what it is.
		await send("pane.rename", { pane_id: paneId, label: id });
		await send("pane.send_input", { pane_id: paneId, text: follow(logPath), keys: ["enter"] });
		return paneId;
	})().catch(() => undefined);

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

/**
 * The `pane.split` a pane is opened with.
 *
 * Its own function because `probeHerdr` sends it too: a probe built from a
 * second copy of these fields would keep answering yes about a request nobody
 * makes any more.
 */
export function splitParams(options: HerdrOptions): Record<string, unknown> {
	return {
		direction: options.split ?? "right",
		focus: options.focus ?? false,
		...(options.pane ? { target_pane_id: options.pane } : {}),
	};
}

/**
 * What the pane is told to run.
 *
 * `exec` because the pane should *be* the stream: what it is following is then
 * its own foreground process, and closing one closes both. `-n +1` shows the
 * file from the top, so the clear and the name written above are the first
 * thing that reaches the terminal.
 */
function follow(logPath: string): string {
	return `exec tail -n +1 -f '${logPath.replace(/'/g, "'\\''")}'`;
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
