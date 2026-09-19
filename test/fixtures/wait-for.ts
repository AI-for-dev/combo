/**
 * Waiting for a run to get going, without guessing how long that takes.
 *
 * A test that stops subagents has to stop them *while they work*, and a
 * `setTimeout` long enough to be safe on a loaded machine is a test that spends
 * its life sleeping. Polling a condition is neither flaky nor slow.
 */

/** Resolves as soon as `ready` holds, and throws rather than hanging. */
export async function waitFor(ready: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!ready()) {
		if (performance.now() > deadline) throw new Error("timed out waiting for the run to get going");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
