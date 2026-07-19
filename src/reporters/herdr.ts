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
import { formatUsage } from "../usage.ts";
import { createHerdrSend, detectHerdr, HERDR_SOURCE, nextSeq, paneIdOf, type HerdrSend } from "./herdr-client.ts";

export type HerdrOptions = {
	/** Where the split opens. Defaults to `"right"`. */
	split?: "right" | "down";
	/** Steal focus when a split opens. Defaults to `false` - you are still typing. */
	focus?: boolean;
	/** Transport. Injection point for tests; defaults to the real socket. */
	send?: HerdrSend;
	/** Directory for the live logs. Defaults to a per-run temp directory. */
	dir?: string;
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
	const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	fs.mkdirSync(dir, { recursive: true });

	const panes = new Map<string, Pane>();

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
			if (!event.openInHerdr) return; // opt-in, and the default is out
			panes.set(event.id, openPane(send, dir, event.id, options));
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
				break;
		}
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
		.then(paneIdOf)
		.catch(() => undefined);

	const onPane = (fn: (paneId: string) => Promise<unknown> | void) => {
		void started
			.then((paneId) => (paneId ? fn(paneId) : undefined))
			.catch(() => undefined);
	};

	return {
		write,

		report(status) {
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
				send("pane.release_agent", { pane_id: paneId, source: HERDR_SOURCE, agent: id, seq: nextSeq() })
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
		.map(([key, value]) => `${key}=${short(value)}`)
		.join(" ");
	return summary ? ` ${summary}` : "";
}

function short(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (!text) return "";
	const oneLine = text.replace(/\s+/g, " ");
	return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
}
