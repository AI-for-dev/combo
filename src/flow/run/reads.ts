/**
 * What a visit shows whoever it asks, a model or a person: each address of
 * its `reads:` as a named section, and `diff`, taken when the visit starts.
 */

import type { Shown } from "../../ask.ts";
import type { GitResult } from "../../git/index.ts";
import type { CheckedRead } from "../checked.ts";
import type { Values } from "./values.ts";
import type { Here } from "./walk.ts";

/** A read as it is shown: its address, its value as a text, and whether that text is JSON. */
export type ShownRead = Shown & { readonly json: boolean };

/**
 * `read` as it is shown, or `undefined` for `<loop>.previous` on a first
 * iteration, which has nothing to show. Text, and a value typed `string`,
 * goes as it is: `input: string` is what a person typed, and a JSON string
 * with its quotes and escaped newlines would change how it reads. Any other
 * value is JSON, and so is a node that failed, the shape a block's failed
 * branch has. An optional field left out still gets its section, empty: the
 * runner writes no "(empty)" of its own.
 */
export function showRead(read: CheckedRead, values: Values): ShownRead | undefined {
	const name = read.address;
	const reading = values.read(name);
	switch (reading.kind) {
		case "failed":
			return { name, body: JSON.stringify(reading.ended, null, 2), json: true };
		case "first":
			return undefined;
		case "absent":
			return { name, body: "", json: false };
		case "value": {
			const plain = typeof reading.value === "string" && (read.type.kind === "text" || read.type.kind === "string");
			return plain ? { name, body: (reading.value as string).trim(), json: false } : { name, body: JSON.stringify(reading.value, null, 2), json: true };
		}
	}
}

/**
 * `here`, with `diff` lent when `reads` names it, or why it could not be
 * read. It is taken now, in the visit's own tree: the one address whose value
 * depends on when and where it is read.
 */
export async function withDiff(diff: (tree: string | undefined) => Promise<GitResult<string>>, reads: readonly CheckedRead[], here: Here): Promise<Here | string> {
	if (!reads.some((read) => read.address === "diff")) return here;
	const taken = await diff(here.tree);
	if (!taken.ok) return `\`diff\`: ${taken.error}`;
	return { ...here, values: here.values.inside().lend("diff", taken.value) };
}
