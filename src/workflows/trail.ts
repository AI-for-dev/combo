/**
 * The trail: every result a workflow produced so far, over its own clock.
 *
 * What a workflow reports besides its answer - the steps it took, what they
 * cost over the time the whole thing took, and the first step that failed -
 * used to be kept by each combinator in its own variables, with its own
 * `performance.now()` and its own sum. The pool records into a trail as it
 * plays turns, so a combinator reads the envelope instead of keeping one.
 */

import type { Result } from "./../result.ts";
import { sumUsage, type Usage } from "./../usage.ts";

/** The results a workflow produced, in order, and what they add up to. */
export class Trail {
	/** Every result recorded, in the order it was recorded. */
	readonly steps: Result[] = [];
	private readonly startedAt = performance.now();

	/** Records a result and hands it back, so a step is recorded where it is made. */
	record<T extends Result>(result: T): T {
		this.steps.push(result);
		return result;
	}

	/**
	 * Every step's usage summed, over the time since the trail was opened.
	 *
	 * The wall time is the trail's own clock, not a sum: a fan-out of three
	 * branches took as long as its slowest branch, and `busyMs / wallMs` is the
	 * parallelism it really achieved.
	 */
	usage(): Usage {
		return sumUsage(
			this.steps.map((step) => step.usage),
			performance.now() - this.startedAt,
		);
	}

	/** The first step that failed, if any. What a workflow's `error` usually is. */
	broken(): Result | undefined {
		return this.steps.find((step) => !step.ok);
	}
}
