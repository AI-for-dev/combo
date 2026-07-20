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
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

/** The last `maxBytes` of text, marked when something was cut. */
function tail(text: string, maxBytes: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxBytes) return trimmed;
	return `[…${trimmed.length - maxBytes} bytes cut]\n${trimmed.slice(-maxBytes)}`;
}
