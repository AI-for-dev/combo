/**
 * A notification fitted to the terminal before pi draws it: paths tidied, and
 * each line cut where a reader would cut it, never in the middle of a path.
 *
 * pi wraps a line too long for the terminal wherever the room runs out, and a
 * path is one long word: `/run resume` of a directory with no run in it put
 * `snapshot.json` on two lines. So every line is cut here first, after a
 * whole fact or at a space, going on under its own text, with the room pi
 * takes for itself counted: one column each side, and the `Error: ` or
 * `Warning: ` it writes before the first line.
 */

import type { Ui } from "./pi.ts";
import { tidy } from "./ui/index.ts";

/**
 * A line of a notification, the column its text goes on at when the terminal
 * is narrower than the line, and whether it is about a refused file.
 */
export type Row = { readonly text: string; readonly hang: number; readonly refused?: boolean };

/** How a notification is drawn: pi's own levels. */
export type Level = NonNullable<Parameters<Ui["notify"]>[1]>;

/** What pi writes before the first line of a notification, at each level. */
const LEAD: Record<Level, string> = { info: "", warning: "Warning: ", error: "Error: " };

/**
 * `rows` as the lines of a notification at `level`, `width` columns wide,
 * paths tidied, each row going on under its `hang`.
 */
export function notified(rows: readonly Row[], cwd: string, width = process.stdout.columns, level: Level = "info"): string[] {
	// pi draws a notification one column in, and a line as wide as the terminal would wrap again.
	const room = width === undefined ? undefined : width - 2;
	return rows.flatMap((row, i) => wrap({ ...row, text: tidy(row.text, cwd) }, room, i === 0 ? LEAD[level].length : 0));
}

/**
 * `message`, a line or several, fitted as a notification at `level`: each
 * line goes on two columns in from where its own text starts.
 */
export function fitted(message: string, cwd: string, level: Level, width = process.stdout.columns): string {
	const rows = message.split("\n").map((text) => ({ text, hang: text.search(/\S|$/) + 2 }));
	return notified(rows, cwd, width, level).join("\n");
}

/**
 * The fewest columns a row goes on in under its `hang`. Narrower, the text
 * would stand a word or two to a line down the right of the terminal: it
 * goes on four columns in instead, and a column of the row that starts at
 * its hang moves down whole.
 */
const NARROW = 24;

/** How far in a row goes on when its hang leaves it fewer than {@link NARROW} columns. */
const NARROW_HANG = 4;

/**
 * A row cut to `width`, its first line `lead` columns shorter, each line
 * after the first starting at its `hang`: after a ` · ` when one fits, so a
 * fact of a plan stays whole, else at a space. A word wider than the room is
 * left whole, for the terminal to wrap.
 */
function wrap(row: Row, width: number | undefined, lead: number): string[] {
	if (width === undefined || row.text.length <= width - lead) return [row.text];
	const lines: string[] = [];
	let { hang } = row;
	let rest = row.text;
	if (width - hang < NARROW && hang > NARROW_HANG) {
		// Two spaces before the hang are the gap before a column: the column moves down whole.
		if (rest.slice(hang - 2, hang) === "  ") {
			lines.push(rest.slice(0, hang).trimEnd());
			rest = `${" ".repeat(NARROW_HANG)}${rest.slice(hang)}`;
		}
		hang = NARROW_HANG;
	}
	for (let room = lines.length === 0 ? width - lead : width; rest.length > room; room = width) {
		const dot = factEnd(rest, room - 2);
		const space = rest.lastIndexOf(" ", room);
		const [end, next] = dot > hang ? [dot + 2, dot + 3] : [space, space + 1];
		if (end <= hang) break;
		lines.push(rest.slice(0, end));
		rest = `${" ".repeat(hang)}${rest.slice(next)}`;
	}
	return [...lines, rest];
}

/**
 * The last ` · ` starting at or before `from` that ends a fact, `-1` for
 * none. A bound is two facts joined the same way, `≤ 4 turns · ≤ 1h`, and
 * reads as one: it is not cut between its turns and its time.
 */
function factEnd(text: string, from: number): number {
	for (let at = text.lastIndexOf(" · ", from); at >= 0; at = text.lastIndexOf(" · ", at - 1)) {
		const start = at === 0 ? -1 : text.lastIndexOf(" · ", at - 1);
		const before = text.slice(start < 0 ? 0 : start + 3, at);
		if (!(before.startsWith("≤ ") && text.startsWith("≤ ", at + 3))) return at;
		if (at === 0) break;
	}
	return -1;
}
