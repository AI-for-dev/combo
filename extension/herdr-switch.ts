/**
 * Session-wide "open a herdr split for every subagent".
 *
 * A module-level switch rather than an argument threaded everywhere: it is a
 * preference about this terminal, it survives across tool calls and commands,
 * and `/herdr on` is how a user sets it without touching a single call site.
 * It starts off: nothing ambient turns it on. The command sets it, the live
 * view reads it, and neither needs the other for that.
 */

let watchAll = false;

/** Whether every subagent currently gets a split. */
export function watchEverything(): boolean {
	return watchAll;
}

/** Turns session-wide watching on or off. Returns the new state. */
export function watchEverythingIs(on: boolean): boolean {
	watchAll = on;
	return watchAll;
}
