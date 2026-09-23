/**
 * Running the code, rather than asking two agents whether they like it.
 *
 * This exists because of a real run: a pair wrote a helper and its tests, the
 * reviewer approved, the auditor approved, and the test file imported
 * `./slugify.js` for a file named `slugify.ts`. The suite did not even load.
 * Both agents had read the code; neither had run it.
 *
 * So verification is a **port**, like {@link AskUser}, and the default
 * implementation runs a command the caller names - no shell, arguments as an
 * array. The pattern is the one `git.ts` already follows: the agents produce
 * text, our code performs the act, and the result comes back as evidence
 * nobody can argue with.
 *
 * A flow's `check` node has a port of its own, {@link CheckScript}: it runs a
 * script whose content was read before the run, so it takes more than
 * `Verify`'s nothing. `Verify` stays for the linear pipeline, and goes with it.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tail } from "./text.ts";

const run = promisify(execFile);

/** What a verification says. `output` is fed to the agents, so it is trimmed. */
export type Verification = {
	/** Whether the command exited zero. When a check is given, this verdict is final. */
	ok: boolean;
	/** Command output, truncated. Both streams: a failure usually speaks on stderr. */
	output: string;
	/** What was run, for a human reading the report. */
	command?: string;
};

/** Runs the project's own check. Injected, so a test never spawns anything. */
export type Verify = () => Promise<Verification>;

/** The check to run: an executable and its arguments, never a shell line. */
export type CommandVerifierOptions = {
	/** Where to run it - the working tree the agents have been editing. */
	cwd: string;
	/** The executable. Not a shell line: `"npm"`, not `"npm test && lint"`. */
	command: string;
	/** Its arguments, one per entry: `["test"]`, not `"test --watch=false"`. */
	args?: string[];
	/** How long the check may take. Defaults to two minutes. */
	timeoutMs?: number;
	/** How much output the agents get to read. Defaults to 8000 bytes. */
	maxBytes?: number;
};

/**
 * A {@link Verify} that runs one command.
 *
 * The **tail** of the output is kept, not the head: a test runner says what
 * failed at the end, and a truncated head would hand the agents a wall of
 * passing tests and hide the one that did not.
 */
export function commandVerifier(options: CommandVerifierOptions): Verify {
	const { cwd, command, args = [], timeoutMs = 120_000, maxBytes = 8_000 } = options;
	const label = [command, ...args].join(" ");

	return async () => {
		try {
			const { stdout, stderr } = await run(command, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
			return { ok: true, output: tail(`${stdout}${stderr}`, maxBytes), command: label };
		} catch (cause) {
			const failure = cause as { stdout?: string; stderr?: string; message?: string };
			const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}` || failure.message || String(cause);
			return { ok: false, output: tail(output, maxBytes), command: label };
		}
	};
}

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
