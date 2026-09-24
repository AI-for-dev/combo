/**
 * One member's place in the board: what it has been handed, whoever handed it.
 *
 * A member is handed posts two ways: by the workflow at the top of its turn,
 * and by its own `read`. With a cursor for each, a `read` after the handout
 * gave back what the handout had just given. Measured in a real pi: a member
 * handed a post read the board at once and was handed it again, and a `read`
 * in round four returned posts from rounds two and three. The cursor is
 * therefore the member's, and both ways move the same one.
 */

import type { Board, Reading } from "./board.ts";

/** What `reader` has not been given yet, from either side. */
export type Reader = {
	/** The next page for this member, moving its one cursor past what was handed. */
	next(limit?: number): Reading;
};

/** A reader starting at the beginning of `board`. */
export function createReader(board: Board, reader: string): Reader {
	let cursor: string | undefined;
	return {
		next(limit) {
			const reading = board.since(reader, cursor, limit);
			cursor = reading.cursor;
			return reading;
		},
	};
}
