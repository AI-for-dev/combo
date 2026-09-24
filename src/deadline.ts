/**
 * A turn's deadline, and how a cut turn tells it from a stop.
 *
 * To pi, a deadline and a stop are the same abort. The difference travels in
 * the signal's reason, so whoever set the deadline, a subagent's own
 * `timeoutMs` or a flow's attempt, the subagent that was cut reads the same
 * words for it, and the transcript, `usage.json` and the journal of a run
 * agree on what happened. It also words the deadline, once, for every bound
 * that fires: a turn's, a question's, a check's.
 */

import { showDuration } from "./duration.ts";

/**
 * How a bound of `ms` that fired reads: `timed out after 30m`, as a flow file
 * writes the bound, or in milliseconds when it is not whole seconds, which
 * rounding would misstate.
 */
export function timedOutAfter(ms: number): string {
	return `timed out after ${ms % 1000 === 0 ? showDuration(ms) : `${ms}ms`}`;
}

/** The reason a deadline of `ms` aborts with: a `TimeoutError`, as `AbortSignal.timeout` gives. */
export function expiry(ms: number): DOMException {
	return new DOMException(timedOutAfter(ms), "TimeoutError");
}

/** A signal that aborts `ms` from now, with {@link expiry} as its reason. Its timer never keeps the process alive. */
export function deadline(ms: number): AbortSignal {
	const controller = new AbortController();
	setTimeout(() => controller.abort(expiry(ms)), ms).unref();
	return controller.signal;
}

/**
 * What `signal` says of a deadline that cut it: the reason's message when it
 * aborted on a `TimeoutError`, `undefined` for any other abort. The first
 * cause wins, since `AbortSignal.any` keeps the reason of whichever fired first.
 */
export function timedOut(signal: AbortSignal): string | undefined {
	const reason: unknown = signal.reason;
	return signal.aborted && reason instanceof DOMException && reason.name === "TimeoutError" ? reason.message : undefined;
}
