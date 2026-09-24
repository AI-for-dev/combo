/**
 * A duration as a person reads it, written the way a flow file writes one, so
 * that a plan, a live line and a deadline's error show `30m` as the file said.
 */

/** Largest units first, rounded up to the second: `1h30m`, and `90s` reads `1m30s`. */
export function showDuration(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	const parts: [number, string][] = [
		[Math.floor(seconds / 3600), "h"],
		[Math.floor((seconds % 3600) / 60), "m"],
		[seconds % 60, "s"],
	];
	const shown = parts.filter(([n]) => n > 0).map(([n, unit]) => `${n}${unit}`);
	return shown.length === 0 ? "0s" : shown.join("");
}
