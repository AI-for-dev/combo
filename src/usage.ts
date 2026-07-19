/**
 * Measurements: time and tokens, per subagent.
 *
 * Nothing is estimated. Tokens and cost come from pi
 * (`session.getSessionStats()`); the only things we add are **time** - which
 * pi does not measure - and **attribution per subagent**.
 */

import type { SessionStats } from "@earendil-works/pi-coding-agent";

/** Measurements of a subagent, or of a single turn of work. */
export type Usage = {
	/** From spawn to close, waiting included. Monotonic clock. */
	wallMs: number;
	/** Time actually spent working: the sum of the `ask` calls. */
	busyMs: number;
	turns: number;

	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;

	/** Current context size. Mostly relevant for a persistent agent. */
	contextTokens?: number;
};

/** A zeroed `Usage`. The starting point of a freshly spawned subagent. */
export function emptyUsage(): Usage {
	return { wallMs: 0, busyMs: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/**
 * Snapshot of a session's token counters.
 *
 * Careful: `getSessionStats()` is **cumulative since the start of the
 * session**. A snapshot is therefore never the usage of a single turn; it is
 * {@link deltaUsage} that extracts one turn, between two snapshots.
 *
 * A field the provider does not report is `0`. We never estimate it by
 * counting characters.
 */
export function snapshotUsage(stats: SessionStats): Usage {
	return {
		wallMs: 0,
		busyMs: 0,
		turns: 0,
		input: stats.tokens.input ?? 0,
		output: stats.tokens.output ?? 0,
		cacheRead: stats.tokens.cacheRead ?? 0,
		cacheWrite: stats.tokens.cacheWrite ?? 0,
		cost: stats.cost ?? 0,
		contextTokens: stats.contextUsage?.tokens ?? undefined,
	};
}

/**
 * Usage of one turn: what `after` has more than `before`.
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
		input: Math.max(0, after.input - before.input),
		output: Math.max(0, after.output - before.output),
		cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
		cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
		cost: Math.max(0, after.cost - before.cost),
		contextTokens: after.contextTokens,
	};
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
		total.input += part.input;
		total.output += part.output;
		total.cacheRead += part.cacheRead;
		total.cacheWrite += part.cacheWrite;
		total.cost += part.cost;
	}
	return total;
}

/** Compact usage line: `3 turns 12.4s ↑12k ↓2.1k R8k $0.0412 ctx:34k`. */
export function formatUsage(usage: Usage): string {
	const parts = [
		`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`,
		`${(usage.busyMs / 1000).toFixed(1)}s`,
		`↑${compact(usage.input)}`,
		`↓${compact(usage.output)}`,
	];
	if (usage.cacheRead > 0) parts.push(`R${compact(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`W${compact(usage.cacheWrite)}`);
	parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens !== undefined) parts.push(`ctx:${compact(usage.contextTokens)}`);
	return parts.join(" ");
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
