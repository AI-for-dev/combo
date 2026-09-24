/**
 * Why a flow is refused before its first spawn: a stable code, the file, where
 * in it, and one sentence.
 *
 * A fault is data, not an exception, so validation hands back every fault at
 * once and a caller formats them as it likes (`/flows` writes one per line,
 * `file at: message`). Codes are a closed set: tests assert them, and the
 * table in `docs/guide/flows.md` explains each one, which `npm test` holds to
 * this list.
 */

import { nearest } from "../nearest.ts";
import { SKILL_CODES } from "../skills.ts";
import { CONDITION_CODES } from "./condition/index.ts";

/** Every code a fault can carry. Adding one means adding its row to the guide's table. */
export const FAULT_CODES = [
	"yaml-syntax",
	"not-a-flow",
	"pipeline-format-removed",
	"name-mismatch",
	"reserved-name",
	"unknown-flow",
	"broken-flow",
	"call-cycle",
	"flow-input-mismatch",
	"missing-key",
	"unknown-key",
	"key-type",
	"node-kind",
	"twin-keys",
	"invalid-id",
	"reserved-id",
	"duplicate-id",
	"unknown-agent",
	"broken-agent",
	...SKILL_CODES,
	"unknown-address",
	"invalid-address",
	"among-without-from",
	"among-mismatch",
	"unknown-scope",
	"memory-output-mismatch",
	"carry-mismatch",
	"verdict-with-output",
	"copies-needed",
	"retry-refused",
	"check-script-missing",
	"check-port-missing",
	"commit-in-copies",
	"memory-outside-copies",
	"ask-form-conflict",
	"ask-options-count",
	"ask-options-duplicate",
	"ask-default-mismatch",
	"git-port-missing",
	"not-a-repository",
	"unattended-ask",
	"section-missing",
	"section-empty",
	"section-duplicate",
	"section-unknown",
	"section-not-agent",
	"body-preamble",
	"schema-invalid",
	...CONDITION_CODES,
] as const;

/** A fault's code. */
export type FaultCode = (typeof FAULT_CODES)[number];

/** One reason a flow is refused. */
export type Fault = {
	/** Stable, and what a test or a caller matches: the guide's table explains each one. */
	readonly code: FaultCode;
	/** The file the fault is in. */
	readonly file: string;
	/**
	 * Where: the node's address through its enclosing nodes, without
	 * iterations, then the offending key (`deliver/work/code.retry`). `""` for
	 * the file as a whole.
	 */
	readonly at: string;
	/** One sentence saying what is wrong, and what was meant when it can tell. */
	readonly message: string;
};

/** `; did you mean \`x\`?` when a candidate is near, else what there is. */
export function suggest(word: string, candidates: readonly string[], what: string): string {
	const near = nearest(word, candidates);
	if (near !== undefined) return `did you mean \`${near}\`?`;
	return candidates.length === 0 ? `there are no ${what}` : `the ${what} are ${candidates.join(", ")}`;
}

/**
 * The faults of one file, as they are found.
 *
 * Every reader pushes into one list, in the order it reads the file, so the
 * faults come back sorted by position without a sort.
 */
export class FaultList {
	readonly list: Fault[] = [];
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	add(code: FaultCode, at: string, message: string): void {
		this.list.push({ code, file: this.file, at, message });
	}

	/**
	 * Sorts the faults added since `mark` by `rank`, keeping the order they were
	 * found in between equals. Readers check what they need in the order they
	 * need it; a reader of the faults wants them in the order of the file.
	 */
	sort(rank: (fault: Fault) => number, mark = 0): void {
		const added = this.list.splice(mark).sort((a, b) => rank(a) - rank(b));
		this.list.push(...added);
	}

	/** A name that matches nothing, with the nearest one or what there is. */
	unknown(code: FaultCode, at: string, word: string, candidates: readonly string[], what: string): void {
		this.add(code, at, `\`${word}\` is unknown; ${suggest(word, candidates, what)}`);
	}

	/** Refuses every key of `record` outside `allowed`, at `<at>.<key>`. */
	keys(record: Readonly<Record<string, unknown>>, allowed: readonly string[], at: string, what: string): void {
		for (const key of Object.keys(record)) {
			if (!allowed.includes(key)) this.unknown("unknown-key", at === "" ? key : `${at}.${key}`, key, allowed, what);
		}
	}
}
