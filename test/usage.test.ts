import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { deltaUsage, emptyUsage, formatUsage, snapshotUsage, sumUsage, type Usage } from "../src/usage.ts";

function stats(tokens: Partial<SessionStats["tokens"]>, cost = 0, contextTokens?: number): SessionStats {
	const filled = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...tokens };
	return {
		sessionFile: undefined,
		sessionId: "s",
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: filled,
		cost,
		contextUsage: contextTokens === undefined ? undefined : { tokens: contextTokens, contextWindow: 200_000, percent: 1 },
	};
}

function usage(partial: Partial<Usage>): Usage {
	return { ...emptyUsage(), ...partial };
}

describe("snapshotUsage", () => {
	test("reads pi's counters verbatim, and zeroes what is not reported", () => {
		const snapshot = snapshotUsage(stats({ input: 120, output: 30 }, 0.004, 8_000));
		assert.equal(snapshot.input, 120);
		assert.equal(snapshot.output, 30);
		assert.equal(snapshot.cacheRead, 0);
		assert.equal(snapshot.cost, 0.004);
		assert.equal(snapshot.contextTokens, 8_000);
	});

	test("leaves contextTokens undefined when pi does not report it", () => {
		assert.equal(snapshotUsage(stats({})).contextTokens, undefined);
	});
});

describe("deltaUsage", () => {
	test("a turn is the difference between two cumulative snapshots", () => {
		const before = snapshotUsage(stats({ input: 100, output: 20 }, 0.01));
		const after = snapshotUsage(stats({ input: 260, output: 55 }, 0.03));

		const turn = deltaUsage(before, after);
		assert.equal(turn.input, 160);
		assert.equal(turn.output, 35);
		assert.ok(Math.abs(turn.cost - 0.02) < 1e-9);
	});

	test("counters never go negative: compaction can walk the totals backwards", () => {
		const before = snapshotUsage(stats({ input: 5_000 }, 0.5));
		const after = snapshotUsage(stats({ input: 800 }, 0.1));

		const turn = deltaUsage(before, after);
		assert.equal(turn.input, 0);
		assert.equal(turn.cost, 0);
	});

	test("contextTokens is a level, not a cumulative counter: the later one wins", () => {
		const before = usage({ contextTokens: 30_000 });
		const after = usage({ contextTokens: 12_000 });
		assert.equal(deltaUsage(before, after).contextTokens, 12_000);
	});
});

describe("sumUsage", () => {
	test("sums the parts and takes wallMs from outside: a fan-out has busyMs > wallMs", () => {
		const branches = [
			usage({ busyMs: 900, turns: 1, input: 100, output: 10, cost: 0.01 }),
			usage({ busyMs: 850, turns: 1, input: 120, output: 12, cost: 0.02 }),
			usage({ busyMs: 800, turns: 1, input: 90, output: 9, cost: 0.03 }),
		];

		const total = sumUsage(branches, 1_000);
		assert.equal(total.busyMs, 2_550);
		assert.equal(total.wallMs, 1_000);
		assert.ok(total.busyMs > total.wallMs, "parallelism must be visible in the numbers");
		assert.equal(total.turns, 3);
		assert.equal(total.input, 310);
		assert.ok(Math.abs(total.cost - 0.06) < 1e-9);
	});

	test("the sum of the parts equals the total, tokens included", () => {
		const parts = [usage({ input: 1, cacheRead: 7 }), usage({ input: 2, cacheRead: 3 })];
		const total = sumUsage(parts, 0);
		assert.equal(total.input, parts[0]!.input + parts[1]!.input);
		assert.equal(total.cacheRead, 10);
	});

	test("a failed branch keeps its tokens in the total", () => {
		const failedBranch = usage({ turns: 1, input: 12_000, cost: 0.4 });
		const total = sumUsage([failedBranch, usage({ turns: 1, input: 500 })], 100);
		assert.equal(total.input, 12_500);
		assert.ok(Math.abs(total.cost - 0.4) < 1e-9);
	});

	test("does not aggregate contextTokens: adding up distinct sessions means nothing", () => {
		const total = sumUsage([usage({ contextTokens: 10_000 }), usage({ contextTokens: 20_000 })], 0);
		assert.equal(total.contextTokens, undefined);
	});

	test("an empty fan-out is zero, not NaN", () => {
		assert.deepEqual(sumUsage([], 42), { ...emptyUsage(), wallMs: 42 });
	});
});

describe("formatUsage", () => {
	test("renders a compact line, omitting cache counters that are zero", () => {
		const line = formatUsage(usage({ turns: 3, busyMs: 12_400, input: 12_000, output: 2_100, cost: 0.0412 }));
		assert.equal(line, "3 turns 12.4s ↑12k ↓2.1k $0.0412");
	});

	test("shows cache and context when present", () => {
		const line = formatUsage(usage({ turns: 1, busyMs: 1_000, input: 500, cacheRead: 8_000, contextTokens: 34_000 }));
		assert.match(line, /R8k/);
		assert.match(line, /ctx:34k/);
	});
});
