/**
 * Measurements: time and tokens, per subagent.
 *
 * Nothing is estimated. Tokens and cost come from pi, read by the session
 * (`src/session.ts`); the only things we add are **time** - which pi does not
 * measure - and **attribution per subagent**.
 */

import { plural } from "./text.ts";

/** Measurements of a subagent, or of a single turn of work. */
export type Usage = {
	/** From spawn to close, waiting included. Monotonic clock. */
	wallMs: number;
	/** Time actually spent working: the sum of the `ask` calls. */
	busyMs: number;
	/** Completed `ask` calls. A turn is one prompt to the session, however many tools it ran. */
	turns: number;
	/**
	 * Tool calls the model made, as pi counts them in the transcript: every one
	 * it asked for, refused or not. Never read from what the model wrote.
	 */
	toolCalls: number;

	/** Input tokens, as pi reported them. `0` when the provider does not say. */
	input: number;
	/** Output tokens, as pi reported them. Never estimated from characters. */
	output: number;
	/** Tokens served from the prompt cache. */
	cacheRead: number;
	/** Tokens written to the prompt cache. */
	cacheWrite: number;
	/** What pi says it cost, in the provider's currency. Summed, never recomputed. */
	cost: number;

	/** Current context size. Mostly relevant for a persistent agent. */
	contextTokens?: number;
};

/** A zeroed `Usage`. The starting point of a freshly spawned subagent. */
export function emptyUsage(): Usage {
	return { wallMs: 0, busyMs: 0, turns: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/**
 * Usage of one turn: what `after` has more than `before`, two readings of a
 * session's cumulative counters.
 *
 * Counters are clamped at `0` - a compacted session can see its totals go
 * backwards, and a negative usage means nothing. `contextTokens` is not a
 * cumulative counter but a level, so we take the one from `after`.
 */
export function deltaUsage(before: Usage, after: Usage): Usage {
	return {
		wallMs: Math.max(0, after.wallMs - before.wallMs),
		busyMs: Math.max(0, after.busyMs - before.busyMs),
		turns: Math.max(0, after.turns - before.turns),
		toolCalls: Math.max(0, after.toolCalls - before.toolCalls),
		input: Math.max(0, after.input - before.input),
		output: Math.max(0, after.output - before.output),
		cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
		cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
		cost: Math.max(0, after.cost - before.cost),
		contextTokens: after.contextTokens,
	};
}

/**
 * A subagent's usage after one more turn.
 *
 * Counters and busy time add up; `wallMs` is the subagent's own clock and is
 * left as it stands; `contextTokens` is a level rather than a counter, so the
 * turn's reading replaces the last one - a turn that reports none leaves the
 * last known level in place. This is the one rule {@link sumUsage} does not
 * have, because a context belongs to one session and a fan-out sums several.
 */
export function accumulate(total: Usage, turn: Usage): Usage {
	return { ...sumUsage([total, turn], total.wallMs), contextTokens: turn.contextTokens ?? total.contextTokens };
}

/**
 * Aggregates the usage of several subagents - typically a fan-out.
 *
 * We **sum**, we never average. And `wallMs` is passed separately rather than
 * summed: it is the real duration of the whole, not the total of the branches.
 * The `busyMs / wallMs` ratio then gives the parallelism actually achieved -
 * which is precisely the number we want to read.
 *
 * `contextTokens` is not aggregated: adding up the contexts of distinct
 * sessions describes nothing.
 */
export function sumUsage(parts: readonly Usage[], wallMs: number): Usage {
	const total = emptyUsage();
	total.wallMs = wallMs;
	for (const part of parts) {
		total.busyMs += part.busyMs;
		total.turns += part.turns;
		total.toolCalls += part.toolCalls;
		total.input += part.input;
		total.output += part.output;
		total.cacheRead += part.cacheRead;
		total.cacheWrite += part.cacheWrite;
		total.cost += part.cost;
	}
	return total;
}

/**
 * Whether a subagent that had tools answered without calling any.
 *
 * A fact read off pi's counters, not a verdict: the turn may still be right,
 * and combo cannot judge its text. Nothing to say before a turn has ended,
 * nor of an agent given no tools at all, which has no other way to answer.
 */
export function calledNoTool(usage: Usage, toolset: readonly string[] | undefined): boolean {
	return (toolset?.length ?? 0) > 0 && usage.turns > 0 && usage.toolCalls === 0;
}

/** The words for {@link calledNoTool}, the same wherever a display says it. */
export const CALLED_NO_TOOL = "called no tool";

/**
 * Compact usage line: `3 turns 12.4s ↑12k ↓2.1k R8k $0.0412 ctx:34k`. The
 * tokens wait for a turn to end and the cost for pi to report one, as in
 * {@link showTokens} and {@link showCost}.
 */
export function formatUsage(usage: Usage): string {
	const parts = [plural(usage.turns, "turn"), `${(usage.busyMs / 1000).toFixed(1)}s`, ...showTokens(usage)];
	if (usage.cacheRead > 0) parts.push(`R${compact(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`W${compact(usage.cacheWrite)}`);
	parts.push(...showCost(usage));
	if (usage.contextTokens !== undefined) parts.push(`ctx:${compact(usage.contextTokens)}`);
	return parts.join(" ");
}

/**
 * `↑12k ↓2.1k` once a turn has ended, and nothing before. pi's counters are
 * read when a turn ends, so a subagent in its first turn has no figure yet,
 * and a `0` there would be one nobody measured. After a turn, a provider that
 * reports nothing reads `↑0 ↓0`: that zero was read.
 */
export function showTokens(usage: Usage): string[] {
	return usage.turns > 0 ? [`↑${compact(usage.input)} ↓${compact(usage.output)}`] : [];
}

/**
 * `$0.0412` when pi reported a cost, and nothing when it did not: several
 * providers report none, and `$0.0000` would read as free.
 */
export function showCost(usage: Usage): string[] {
	return usage.cost > 0 ? [`$${usage.cost.toFixed(4)}`] : [];
}

/** `12k`, `2.1k`, `1.4M` - a token count that fits in a narrow column. */
export function compact(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${trim((n / 1000).toFixed(n < 10_000 ? 1 : 0))}k`;
	return `${trim((n / 1_000_000).toFixed(1))}M`;
}

/** `8.0k` reads as noise next to `12k`: a trailing `.0` carries nothing. */
function trim(value: string): string {
	return value.endsWith(".0") ? value.slice(0, -2) : value;
}
