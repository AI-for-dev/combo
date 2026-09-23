/**
 * Reading what was typed after a command: the leading `--flags`, the free
 * text that follows them, and for `/run`, the flags that end the line.
 */

/** `/interview [--model <pattern>] [--questions <n>] <request>`. */
export function parseInterviewArgs(args: string): { model?: string; questions?: number; request: string } {
	const { flags, rest } = parseLeadingFlags(args, ["model", "questions"]);
	const parsed: ReturnType<typeof parseInterviewArgs> = { request: rest };
	if (flags.model) parsed.model = flags.model;

	// A count that is not one is dropped rather than guessed at: `--questions x`
	// is a typo, and turning it into 0 would silently skip the interview.
	const questions = Number(flags.questions);
	if (Number.isInteger(questions) && questions > 0) parsed.questions = questions;
	return parsed;
}

/**
 * What separates two flags: whitespace, and the `\` a wrapped line ends on.
 *
 * A backslash is not `--`, so a parse that skipped only whitespace stopped on
 * it and read the rest as free text: the flags written after the wrap were
 * dropped in silence, and the backslash went into the request. Measured: a
 * `/swarm` wrapped before its `--model` ran every member on pi's own model,
 * and nothing said so.
 *
 * Only between flags. A backslash inside the request is the user's, and stays
 * where they put it.
 */
const GAP = String.raw`(?:\s|\\\r?\n)*`;

/** A flag name, and the `=value` written against it. */
const HEAD = new RegExp(String.raw`^${GAP}--([a-z]+)(?:=(\S+))?`, "i");

/**
 * A flag that takes a value, up to and including the gap after it.
 *
 * The value is one word, or a double-quoted run of them: `--check "npm test"`
 * names a command and its arguments, and without the quotes `test` would start
 * the request.
 */
const VALUED = new RegExp(String.raw`^${GAP}--[a-z]+(?:=|\s+)(?:"([^"]*)"|(\S+))${GAP}`, "i");

/**
 * Reads leading flags off a command line, in any order.
 *
 * Only the given names are consumed: an unknown `--flag` stays in the text,
 * because in free prose it may simply *be* the text. `=` and a space both
 * separate a value, like everywhere in pi.
 *
 * A name in `switches` takes no value and arrives as `"true"`. Which list a
 * name is in has to be decided here rather than guessed from what follows it:
 * in `--agent explore the parser`, `explore` is the name and not the flag's value.
 *
 * A {@link GAP} between two flags may hold a line continuation: a command with
 * six flags on it gets written across two lines by whoever has to read it back.
 */
export function parseLeadingFlags(
	args: string,
	names: readonly string[],
	switches: readonly string[] = [],
): { flags: Record<string, string>; rest: string } {
	const flags: Record<string, string> = {};
	let rest = args;

	for (;;) {
		// The name first, and an `=value` only if it is written that way. What
		// follows a space is claimed by a valued flag and left alone by a switch.
		const head = HEAD.exec(rest);
		const name = head?.[1]?.toLowerCase();
		if (!head || !name) break;

		if (switches.includes(name)) {
			flags[name] = head[2] === "false" ? "false" : "true";
			rest = rest.slice(head[0].length);
			continue;
		}
		if (!names.includes(name)) break;

		const valued = VALUED.exec(rest);
		const value = valued?.[1] ?? valued?.[2];
		if (!valued || !value) break;
		flags[name] = value;
		rest = rest.slice(valued[0].length);
	}

	return { flags, rest: rest.trim() };
}

/** A valued flag ending the line, and the gap before it. */
const TRAILING = new RegExp(String.raw`\s--([a-z]+)(?:=|\s+)(?:"([^"]*)"|(\S+))\s*$`, "i");

/**
 * Reads leading flags, then the valued ones among `names` that end the line.
 *
 * A known flag written after the text was read as the text, in silence.
 * Measured: `/run explore where is the wall time measured --model
 * ilaas/mistral-small-4-119b` ran three scouts on another model, and one of
 * them spent its turn grepping the repository for the model's name. A line
 * does not end on `--model <pattern>` as prose; a flag in the middle of it
 * still is prose, and stays in the text.
 */
export function parseFlags(args: string, names: readonly string[]): { flags: Record<string, string>; rest: string } {
	const { flags, rest } = parseLeadingFlags(args, names);
	let text = rest;
	for (let found = TRAILING.exec(text); found !== null; found = TRAILING.exec(text)) {
		const name = found[1]?.toLowerCase() as string;
		const value = found[2] ?? found[3];
		if (!names.includes(name) || !value || flags[name] !== undefined) break;
		flags[name] = value;
		text = text.slice(0, found.index);
	}
	return { flags, rest: text.trim() };
}
