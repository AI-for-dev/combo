import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failed, type Result } from "../src/result.ts";
import { emptyUsage } from "../src/usage.ts";
import { Trail } from "../src/workflows/trail.ts";

const step = (agent: string, busyMs: number, input: number): Result => ({
	agent,
	output: "",
	messages: [],
	usage: { ...emptyUsage(), busyMs, input, turns: 1 },
	ok: true,
});

describe("Trail", () => {
	test("records in order, and hands each step back", () => {
		const trail = new Trail();
		const first = trail.record(step("a", 1, 1));
		const second = trail.record(step("b", 1, 1));

		assert.deepEqual(trail.steps, [first, second]);
		assert.equal(first.agent, "a", "what was recorded is what comes back");
	});

	test("usage is the sum of the steps over the trail's own clock", async () => {
		const trail = new Trail();
		trail.record(step("a", 500, 10));
		trail.record(step("b", 400, 20));
		// Measured on the same clock the trail reads, so the bound holds whatever
		// the timer's granularity.
		const before = performance.now();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const slept = performance.now() - before;

		const usage = trail.usage();

		assert.equal(usage.busyMs, 900);
		assert.equal(usage.input, 30);
		assert.equal(usage.turns, 2);
		assert.ok(usage.wallMs >= slept, "the wall time is elapsed time, not the sum of the steps");
		assert.ok(usage.wallMs < 900, "a fan-out's wall time is not its branches added up");
	});

	test("an empty trail costs nothing, and still knows how long it has been open", () => {
		const usage = new Trail().usage();

		assert.deepEqual({ ...usage, wallMs: 0 }, emptyUsage());
		assert.ok(usage.wallMs >= 0);
	});

	test("broken is the first step that failed, whatever came after", () => {
		const trail = new Trail();
		trail.record(step("a", 1, 1));
		const first = trail.record(failed("b", "exploded"));
		trail.record(failed("c", "also exploded"));
		trail.record(step("d", 1, 1));

		assert.equal(trail.broken(), first);
	});

	test("nothing broken when every step ran", () => {
		const trail = new Trail();
		trail.record(step("a", 1, 1));

		assert.equal(trail.broken(), undefined);
	});
});
