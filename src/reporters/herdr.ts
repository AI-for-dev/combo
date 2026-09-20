/**
 * The herdr reporter: one split per subagent, showing it work.
 *
 * A herdr pane cannot *host* an in-process subagent - there is no process and
 * no TTY to attach. So the pane hosts a **client of the mirror** instead: the
 * pane runs `pane/main.ts`, which attaches to the subagent by id, draws the
 * session with pi's own components and sends the keyboard back. The pane is
 * then ours, which is also why we can report agent state on it: the main
 * pane's state already belongs to herdr's own pi integration, and two sources
 * cannot own one pane.
 *
 * The board is the one pane that still displays a stream we write: nobody
 * works in it, nothing is typed to it, and its lines are `traffic.ts`'s so the
 * console and the pane read the same. It gets a file and `tail -f`.
 *
 * Opening either takes three calls, because herdr has none that does all
 * three: `pane.split` makes the pane and hands back its id, `pane.rename` puts
 * the name on it, and `pane.send_input` types the command into the shell the
 * split started. `agent.start` sounds like the call that opens one and is not:
 * it puts a *recognised* agent into a pane that already exists.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventListener, SubagentEvent, SubagentStatus } from "../events.ts";
import { mirrorSocket } from "../mirror.ts";
import { plural } from "../text.ts";
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
	/** Directory for the board's live log. Defaults to a per-run temp directory. */
	dir?: string;
	/**
	 * The mirror's socket, which a subagent's pane attaches to. Defaults to this
	 * process's, started on the first pane. Tests name one that nothing listens
	 * on, so a reporter test opens no socket.
	 */
	mirror?: string;
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
	const all = options.all ?? false;
	let dir: string | undefined;
	const logDir = () => (dir ??= options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "combo-")));

	const panes = new Map<string, Pane>();
	// The board is a pane of the **run**, not of a member: what one said is in
	// its own pane, and who it was talking to is only legible where all of them
	// are. Opened on the first thing anybody says, so a run with no board never
	// grows a window for one.
	let board: BoardPane | undefined;
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
			panes.set(event.id, openPane(send, event.id, options, paneCommand(event.id, options.mirror ?? mirrorSocket())));
			return;
		}

		// What passed between members. Each member's own pane draws its half as
		// the tool calls it made; the board is where the exchange reads in order.
		const traffic = trafficLine(event);
		if (traffic !== undefined) {
			lines += 1;
			boardPane()?.write(`${traffic}\n`);
			return;
		}

		const pane = panes.get(event.id);
		if (!pane) return; // a subagent that did not ask for a split

		// Text, tool calls and usage reach the pane through the mirror, not
		// through us: the pane draws the session, this only keeps herdr told.
		switch (event.type) {
			case "status":
				pane.report(event.status);
				break;
			case "close":
				panes.delete(event.id);
				pane.finish();
				// The board goes when the last member does: it belongs to the run,
				// and a pane left behind is one the next run opens beside.
				if (panes.size === 0 && board) {
					board.write(`\n--\n${plural(lines, "line")} between them\n`);
					board.finish();
					board = undefined;
				}
				break;
		}
	}

	/** The board's pane, opened on demand - and only when this run is watched. */
	function boardPane(): BoardPane | undefined {
		// Nobody watching any member is nobody watching the run: a board pane on
		// its own would be a window that was never asked for.
		if (!board && (all || panes.size > 0)) board = openBoard(send, logDir(), options);
		return board;
	}
}

type Pane = {
	/** Tells herdr what the subagent in this pane is doing. */
	report(status: SubagentStatus): void;
	/** Releases the agent if one was reported, then closes the pane. */
	finish(): void;
};

type BoardPane = Pane & {
	/** Appends to the stream the pane follows. */
	write(text: string): void;
};

/**
 * Opens one split running `command`, and returns the handle used to keep herdr told.
 *
 * `pane.split` is asynchronous, but events arrive immediately: everything is
 * queued behind the pending pane id, so nothing is lost and nothing blocks.
 */
function openPane(send: HerdrSend, id: string, options: HerdrOptions, command: string): Pane {
	// Only a pane that had an agent reported on it has one to release. The board
	// is a pane and not an agent, and releasing one herdr never heard of is a
	// call that can only go wrong.
	let reported = false;

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
		await send("pane.send_input", { pane_id: paneId, text: command, keys: ["enter"] });
		return paneId;
	})().catch(() => undefined);

	const onPane = (fn: (paneId: string) => Promise<unknown> | void) => {
		void started
			.then((paneId) => (paneId ? fn(paneId) : undefined))
			.catch(() => undefined);
	};

	return {
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

		finish() {
			onPane((paneId) =>
				(reported
					? send("pane.release_agent", { pane_id: paneId, source: HERDR_SOURCE, agent: id, seq: nextSeq() })
					: Promise.resolve(undefined))
					// Close after the release, not in parallel: closing first would
					// leave herdr holding an agent on a pane that no longer exists.
					.then(() => send("pane.close", { pane_id: paneId })),
			);
		},
	};
}

/**
 * The board: a pane following a file we append to.
 *
 * The name, over a cleared screen, is written into the file rather than run as
 * a command, because the shell that runs the command is still starting up and
 * writes over anything printed before it finished - measured, as a zsh history
 * warning sitting on top of a member's first turn.
 */
function openBoard(send: HerdrSend, dir: string, options: HerdrOptions): BoardPane {
	const logPath = path.join(dir, `${BOARD_PANE}.log`);
	fs.writeFileSync(logPath, `\u001b[2J\u001b[H${BOARD_PANE}\n\n`);
	const pane = openPane(send, BOARD_PANE, options, follow(logPath));

	return {
		...pane,
		// Writes are appended synchronously and in order: interleaved async
		// appends would scramble the exchange, which is precisely what is shown.
		write(text) {
			try {
				fs.appendFileSync(logPath, text);
			} catch {
				// the pane may already be gone; that is not a workflow error
			}
		},
		finish() {
			pane.finish();
			try {
				fs.rmSync(logPath, { force: true });
			} catch {
				// best effort; the temp directory goes away anyway
			}
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
 * What a subagent's pane runs: the pane client, on the node this process runs.
 *
 * `exec`, so the pane *is* the client and closing one closes both. The binary
 * is ours rather than whatever `node` the split's shell finds, so the pane runs
 * the TypeScript the way this process does - unless this process is not node
 * at all, in which case the shell's `node` is the only candidate left.
 */
export function paneCommand(id: string, socket: string): string {
	const node = process.versions.node ? process.execPath : "node";
	const main = fileURLToPath(new URL("../../pane/main.ts", import.meta.url));
	return `exec ${quote(node)} ${quote(main)} --socket ${quote(socket)} --id ${quote(id)}`;
}

/** What the board's pane runs: the file from the top, then everything appended. */
function follow(logPath: string): string {
	return `exec tail -n +1 -f ${quote(logPath)}`;
}

function quote(word: string): string {
	return `'${word.replace(/'/g, "'\\''")}'`;
}
