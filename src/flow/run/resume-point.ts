/**
 * `resumePoint`: where a run picks up from its journal, or why it may not.
 *
 * It is the runner's own reading, shared by a real resume and a dry run's
 * `from: journal`, so a resume can be tried offline and read the same. The
 * walk itself decides what runs, visit by visit, from the {@link Replay};
 * `from` only says, for whoever asked, the first visit in the order of the
 * file that did not end.
 */

import type { CheckedFlow, CheckedNode, ErrorKind } from "../checked.ts";
import { under } from "./ended.ts";
import type { JournalEntry } from "./journal.ts";
import { Replay } from "./replay.ts";

/**
 * The failures a resume refuses to replay: the flow decided them from values
 * that survive, so the failed visit would decide the same again. A loop's
 * cap and `give-up`, a condition that could not be read, a list past `max:`,
 * a commit with no message.
 */
const DECIDED: readonly ErrorKind[] = ["unconverged", "condition", "too-many", "empty-message"];

/**
 * Where a run picks up: `from`, the first visit that did not end, `""` when
 * every root node did, and what the walk replays; or why it may not resume.
 */
export type ResumePoint = { readonly ok: true; readonly from: string; readonly replay: Replay } | { readonly ok: false; readonly refused: string };

/**
 * Where the run of `checked` that wrote `journal` picks up. A run that ended
 * well has nothing left; one that failed by a decision of the flow would
 * fail the same. A journal naming a visit the flow has not was written by
 * another flow.
 */
export function resumePoint(checked: CheckedFlow, journal: readonly JournalEntry[]): ResumePoint {
	const replay = Replay.of(checked, journal);
	if (typeof replay === "string") return { ok: false, refused: `the journal names the visit \`${replay}\`, which \`${checked.name}\` does not have: it was written by another flow` };
	const end = replay.runEnd;
	if (end?.ok) return { ok: false, refused: "the run already ended well: there is nothing to resume" };
	if (end?.error !== undefined && DECIDED.includes(end.error.kind)) {
		return { ok: false, refused: `the run failed at \`${end.path}\` by a decision of the flow (${end.error.kind}: ${end.error.message}), and replaying it would decide the same: a new run is how to change it` };
	}
	return { ok: true, from: firstOpen(checked.nodes, "", replay) ?? "", replay };
}

/** The first visit of `nodes`, inside `prefix`, that did not end and survive. */
function firstOpen(nodes: readonly CheckedNode[], prefix: string, replay: Replay): string | undefined {
	for (const node of nodes) {
		const path = under(prefix, node.id);
		if (replay.ended(path) === undefined) return inside(node, path, replay);
	}
	return undefined;
}

/** The first visit that did not end inside `node`'s visit `path`, or `path` itself when none inside has begun. */
function inside(node: CheckedNode, path: string, replay: Replay): string {
	switch (node.kind) {
		case "loop": {
			let n = 1;
			while (n < node.max && replay.touched(`${path}#${n + 1}`)) n++;
			// An iteration that ended whole is followed by the next, short of the cap.
			const next = n < node.max ? firstOpen(node.nodes, `${path}#${n + 1}`, replay) : undefined;
			return firstOpen(node.nodes, `${path}#${n}`, replay) ?? next ?? path;
		}
		case "map": {
			const items = replay.items(path) ?? [];
			return firstIn(items.map((_, i) => ({ prefix: `${path}[${i + 1}]`, nodes: node.nodes })), replay) ?? path;
		}
		case "parallel":
			return firstIn(node.branches.map(({ name, nodes }) => ({ prefix: under(path, name), nodes })), replay) ?? path;
		case "choice": {
			// Ids are unique in a file, so the case taken is the one whose nodes ran.
			const taken = [...node.cases.map((one) => one.nodes), node.otherwise].find((nodes) => nodes.some((one) => replay.touched(under(path, one.id))));
			return (taken && firstOpen(taken, path, replay)) ?? path;
		}
		case "flow":
			return replay.touched(path) ? (firstOpen(node.callee.nodes, path, replay) ?? path) : path;
		default:
			return path;
	}
}

function firstIn(branches: readonly { readonly prefix: string; readonly nodes: readonly CheckedNode[] }[], replay: Replay): string | undefined {
	for (const { prefix, nodes } of branches) {
		const open = firstOpen(nodes, prefix, replay);
		if (open !== undefined) return open;
	}
	return undefined;
}
