/**
 * Reading the nodes that act on the world. An agent produces text; these are
 * where our code performs the act, so each holds nothing a model wrote.
 *
 * A `check` names a script of the project rather than a command: the script
 * belongs to the project, so one flow runs on projects that check themselves
 * differently, and there is one form to read.
 */

import { posix } from "node:path";
import type { CheckNode, NodeReading } from "./node.ts";
import { duration, text } from "./value.ts";

/** A check's bound when its node sets none: a suite, not an agent turn. */
export const CHECK_TIMEOUT_MS = 120_000;

/** A `check`, or `undefined` when a fault refused it. */
export function readCheck({ raw, id, at, faults, continueOnFail }: NodeReading): CheckNode | undefined {
	const written = text(raw.check, `${at}.check`, faults);
	const script = written === undefined ? undefined : posix.normalize(written);
	if (script !== undefined && (posix.isAbsolute(script) || script === ".." || script.startsWith("../"))) {
		faults.add("key-type", `${at}.check`, `\`${written}\`: a check names a script by its path from the repository root, as \`.pi/checks/tests.sh\``);
		return undefined;
	}
	const timeoutMs = raw.timeout === undefined ? CHECK_TIMEOUT_MS : duration(raw.timeout, `${at}.timeout`, faults);
	if (script === undefined || timeoutMs === undefined) return undefined;
	return { kind: "check", id, at, continueOnFail, script, timeoutMs };
}
