/**
 * Who owns escape: a question card, for as long as one is on screen.
 *
 * A question card says `esc` means "write the brief with what you have", and
 * the interviewer that will write that brief is a subagent of the very run
 * the stop key can stop. Measured: pressing `esc` on the first card of an
 * interview ended with `interview failed: stopped`, because both meanings fired and the
 * stop won. While a card is open the key belongs to the card, and the run's
 * own subagents are idle anyway - nothing is running that a person would want
 * to call off by pressing it.
 *
 * Its own module because the card sets it and the stop key reads it, and the
 * two must not depend on each other for a counter.
 */

/** How many question cards are open. Escape is theirs while it is not zero. */
let asking = 0;

/**
 * Runs `work` with escape left to whoever is asking the user something.
 *
 * A counter and not a flag, because the free-text box that follows "Other…" is
 * a second prompt inside the first answer.
 */
export async function whileAsking<T>(work: () => Promise<T>): Promise<T> {
	asking++;
	try {
		return await work();
	} finally {
		asking--;
	}
}

/** Whether a question card currently owns escape. */
export function isAsking(): boolean {
	return asking > 0;
}
