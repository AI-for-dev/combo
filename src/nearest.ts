/**
 * The name that was probably meant, for a message that refuses one.
 *
 * Shared by a flow's faults and by skill lookup, which both answer a name that
 * matches nothing with the one closest to it.
 */

/**
 * The candidate closest to `word`, when it is close enough to be the one meant.
 *
 * Close enough is two edits, or one for a word of three letters or fewer, so a
 * short typo is not "corrected" into an unrelated short word.
 */
export function nearest(word: string, candidates: Iterable<string>): string | undefined {
	const limit = word.length <= 3 ? 1 : 2;
	let best: string | undefined;
	let bestDistance = limit + 1;
	for (const candidate of candidates) {
		const d = distance(word, candidate);
		if (d < bestDistance) [best, bestDistance] = [candidate, d];
	}
	return best;
}

/** Levenshtein distance, two rows at a time. */
function distance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
		}
		previous = current;
	}
	return previous[b.length] as number;
}
