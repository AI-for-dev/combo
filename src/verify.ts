/**
 * Running the code, rather than asking two agents whether they like it.
 *
 * This exists because of a real run: a pair wrote a helper and its tests, the
 * reviewer approved, the auditor approved, and the test file imported
 * `./slugify.js` for a file named `slugify.ts`. The suite did not even load.
 * Both agents had read the code; neither had run it.
 *
 * So a flow's `check` node runs a script of the project through a **port**,
 * like {@link AskUser}. The pattern is the one `git.ts` already follows: the
 * agents produce text, our code performs the act, and the result comes back as
 * evidence nobody can argue with.
 */

import { spawn } from "node:child_process";
import { tail } from "./text.ts";

/** How much of a check script's output its report keeps: the end of it. */
const REPORT_BYTES = 8_000;

/** A check script to run, its content read before the run started. */
export type ScriptRequest = {
	/** Its path from the root of the tree: `$0` inside it, and what a report names. */
	readonly script: string;
	/** What runs. Never read again from disk, so an agent editing the file changes nothing. */
	readonly content: string;
	/** The working tree it runs in. */
	readonly cwd: string;
	/** How long it may run before it is killed. */
	readonly timeoutMs: number;
	/** Aborting it kills the script. */
	readonly signal?: AbortSignal;
};

/**
 * How a check script ended. `passed: false` is any exit but 0: a red check,
 * which the work can fix. Not ending is apart: the script could not start, it
 * ran past its bound, or it was stopped, and no change to the code answers that.
 */
export type ScriptOutcome =
	| { readonly ok: true; readonly passed: boolean; readonly report: string }
	| { readonly ok: false; readonly kind: "unavailable" | "timeout" | "stopped"; readonly message: string };

/** Runs a check script. Injected, so a flow's dry run and its tests spawn nothing. */
export type CheckScript = (request: ScriptRequest) => Promise<ScriptOutcome>;

/**
 * A {@link CheckScript} that runs the content with `bash -c`, `$0` being the
 * script's path, and stdout and stderr mixed in the order they came.
 *
 * The script leads a process group of its own, and the whole group is killed
 * when it exits, times out or is stopped: a test runner leaves workers behind,
 * and a worker holding the pipes open would hold the check open with it.
 * `bash` is the executable, a knob so a test can name one that is not there.
 */
export function bashCheck(bash = "bash"): CheckScript {
	return ({ script, content, cwd, timeoutMs, signal }) =>
		new Promise((resolve) => {
			let kept = "";
			let dropped = 0;
			let ended: ScriptOutcome | undefined;
			const child = spawn(bash, ["-c", content, script], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			const killGroup = () => {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				} catch {
					// The group is already gone.
				}
			};
			const stop = (outcome: ScriptOutcome) => {
				ended ??= outcome;
				killGroup();
			};
			const timer = setTimeout(() => stop({ ok: false, kind: "timeout", message: `\`${script}\` ran past its bound of ${timeoutMs} ms` }), timeoutMs);
			const onAbort = () => stop({ ok: false, kind: "stopped", message: "stopped" });
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			const take = (chunk: string) => {
				kept += chunk;
				if (kept.length > 2 * REPORT_BYTES) {
					dropped += kept.length - REPORT_BYTES;
					kept = kept.slice(-REPORT_BYTES);
				}
			};
			for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", take);
			child.on("exit", killGroup);
			const settle = (outcome: ScriptOutcome) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(ended ?? outcome);
			};
			child.on("error", (error) => settle({ ok: false, kind: "unavailable", message: `\`${bash}\` could not start: ${error.message}` }));
			child.on("close", (code) => settle({ ok: true, passed: code === 0, report: tail(kept, REPORT_BYTES, dropped) }));
		});
}
