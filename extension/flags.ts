/**
 * Reading what was typed after a command: the leading `--flags`, and the free
 * text that follows them.
 */

/**
 * `/build [--pipeline <name>] [--model <pattern>] <request>`.
 *
 * Flags rather than positional words, because a request is free text: any
 * convention that reads the first word as a pipeline name eventually swallows
 * someone's "build fix the parser". Both flags, in either order.
 */
export function parseBuildArgs(args: string): {
	pipeline?: string;
	model?: string;
	worktree?: boolean;
	questions?: number;
	request: string;
} {
	const { flags, rest } = parseLeadingFlags(args, ["pipeline", "model", "questions"], ["worktree"]);
	const parsed: ReturnType<typeof parseBuildArgs> = { request: rest };
	if (flags.pipeline) parsed.pipeline = flags.pipeline;
	if (flags.model) parsed.model = flags.model;
	// Set only when it was written: an explicit `undefined` spread over a default
	// silently wins, and the default is the whole point of leaving it unsaid.
	const worktree = switchValue(flags, "worktree");
	if (worktree !== undefined) parsed.worktree = worktree;

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

/** A flag that takes a value, up to and including the gap after it. */
const VALUED = new RegExp(String.raw`^${GAP}--[a-z]+(?:=|\s+)(\S+)${GAP}`, "i");

/**
 * Reads leading flags off a command line, in any order.
 *
 * Only the given names are consumed: an unknown `--flag` stays in the text,
 * because in free prose it may simply *be* the text. `=` and a space both
 * separate a value, like everywhere in pi.
 *
 * A name in `switches` takes no value and arrives as `"true"`. Which list a
 * name is in has to be decided here rather than guessed from what follows it:
 * in `--worktree add a cache`, `add` is the request and not the flag's value.
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
		if (!valued?.[1]) break;
		flags[name] = valued[1];
		rest = rest.slice(valued[0].length);
	}

	return { flags, rest: rest.trim() };
}

/**
 * A switch that can be left unsaid.
 *
 * `--worktree` is `true`, `--worktree=false` is `false`, and absent is
 * `undefined` - which is not the same as `false` any more: it is what lets the
 * workflow decide from the plan it just made. Coercing it here is how the
 * default would be lost on its way through a command.
 */
export function switchValue(flags: Record<string, string>, name: string): boolean | undefined {
	const raw = flags[name];
	return raw === undefined ? undefined : raw === "true";
}
