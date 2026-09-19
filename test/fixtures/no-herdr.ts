/**
 * Runs a body with herdr's markers out of the environment.
 *
 * The suite must answer the same inside herdr and outside it. Two tests used to
 * assert on `detectHerdr()` reading the real `process.env`, with a comment
 * saying the suite never runs inside herdr - which is false for anyone
 * developing this in the window it is written for, and there both of them
 * passed for the wrong reason. One of them opened a pane.
 */
export function withoutHerdr<T>(body: () => T): T {
	const saved = Object.entries(process.env).filter(([key]) => key.startsWith("HERDR_"));
	for (const [key] of saved) delete process.env[key];
	try {
		return body();
	} finally {
		for (const [key, value] of saved) process.env[key] = value;
	}
}
