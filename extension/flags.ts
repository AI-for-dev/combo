/**
 * Reading what was typed after a command: the leading `--flags`, the free
 * text that follows them, and for `/run`, the flags that end the line.
 */

/** `/interview [--model <pattern>] [--questions <n>] <request>`. */
export function parseInterviewArgs(args: string): { model?: string; questions?: number; request: string; refused?: string } {
	const { flags, rest, refused } = parseLeadingFlags(args, ["model"], { counts: ["questions"] });
	const parsed: ReturnType<typeof parseInterviewArgs> = { request: rest };
	if (refused) parsed.refused = refused;
	if (flags.model) parsed.model = flags.model;
	if (flags.questions) parsed.questions = Number(flags.questions);
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
const HEAD = new RegExp(String.raw`^${GAP}--([a-z]+)(?:=(\S*))?`, "i");

/**
 * A flag that takes a value, up to and including the gap after it.
 *
 * The value is one word, or a double-quoted run of them: `--check "npm test"`
 * names a command and its arguments, and without the quotes `test` would start
 * the request.
 */
const VALUED = new RegExp(String.raw`^${GAP}--[a-z]+(?:=|\s+)(?:"([^"]*)"|(\S+))${GAP}`, "i");

/** A count as it is typed: `1.5`, `0x10` or `1e2` is a number, and not what anybody means by one. */
const COUNT = /^[1-9]\d*$/;

/** Which of the names a command reads take no value, and which take a count. */
export type FlagKinds = {
	/** Flags that take no value: `--name`, `--name=true` or `--name=false`. */
	switches?: readonly string[];
	/** Valued flags whose value is a whole number of at least 1. */
	counts?: readonly string[];
};

/**
 * What was read off a line. `refused` names the first flag written with a
 * value it does not take, and what it takes: the command says so and runs
 * nothing, since whatever it did instead is a guess at what was meant.
 */
export type ReadFlags = { flags: Record<string, string>; rest: string; refused?: string };

/**
 * Reads leading flags off a command line, in any order.
 *
 * Only the given names are consumed: an unknown `--flag` stays in the text,
 * because in free prose it may simply *be* the text. `=` and a space both
 * separate a value, like everywhere in pi.
 *
 * A switch arrives as `"true"` or `"false"`, and absent when it was not
 * written, which is a third answer and not `false`. Which list a name is in
 * has to be decided here rather than guessed from what follows it: in
 * `--agent explore the parser`, `explore` is the name and not the flag's value.
 * `--agent=no` is refused rather than read: `no`, `off` and `0` are words
 * somebody writes to mean false, and reading any word but `false` as true
 * would do the opposite of what was typed.
 *
 * A {@link GAP} between two flags may hold a line continuation: a command with
 * six flags on it gets written across two lines by whoever has to read it back.
 */
export function parseLeadingFlags(args: string, names: readonly string[], kinds: FlagKinds = {}): ReadFlags {
	const { switches = [], counts = [] } = kinds;
	const flags: Record<string, string> = {};
	let rest = args;
	const refuse = (name: string, takes: string, value: string): ReadFlags => ({ flags, rest: rest.trim(), refused: `--${name} takes ${takes}, not "${value}"` });

	for (;;) {
		// The name first, and an `=value` only if it is written that way. What
		// follows a space is claimed by a valued flag and left alone by a switch.
		const head = HEAD.exec(rest);
		const name = head?.[1]?.toLowerCase();
		if (!head || !name) break;

		if (switches.includes(name)) {
			const value = head[2]?.toLowerCase() ?? "true";
			if (value !== "true" && value !== "false") return refuse(name, "no value, or =true or =false", head[2] ?? "");
			flags[name] = value;
			rest = rest.slice(head[0].length);
			continue;
		}
		if (!names.includes(name) && !counts.includes(name)) break;

		const valued = VALUED.exec(rest);
		const value = valued?.[1] ?? valued?.[2];
		if (!valued || !value) break;
		if (counts.includes(name) && !COUNT.test(value)) return refuse(name, "a whole number of at least 1", value);
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
