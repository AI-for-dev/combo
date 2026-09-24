/**
 * The board as one member sees it for one turn: a cap on its results.
 *
 * A member's definition can ask for one `result` a turn, and a prompt is not a
 * boundary. Measured in a real pi on gemma-4-31b: in the first round, while
 * the others were still working, one debater read an empty board, posted its
 * vote again, and did that seven times in one turn. The next round, the other
 * two were handed nine posts, most of them that one vote, and came round to
 * it. A vote repeated is not an argument, and the ones who read it counted it
 * as one.
 *
 * So a turn caps the results, and only the results: a `tell` is how a member
 * thinks aloud, and the caps on the board still bound it. The refusal tells the
 * member to end its turn, since what it is waiting for arrives at the top of
 * the next one.
 */

import type { Board } from "./board.ts";

/** A member's board, counted by turn. */
export type TurnBoard = {
	/** What the member's tool posts to. Everything else goes straight through. */
	board: Board;
	/** A new turn: the count starts over. */
	begin(): void;
};

/** `board`, refusing a `result` past `results` in one turn. */
export function turnBoard(board: Board, results: number): TurnBoard {
	let posted: string[] = [];
	return {
		board: {
			post(from, draft) {
				if (draft.kind === "result" && posted.length >= results) {
					return {
						ok: false,
						error:
							`you already posted your result for this turn as ${posted.join(", ")}. ` +
							"Say the rest as a `tell`, or end your turn: what the others post reaches you at the top of your next one",
					};
				}
				const outcome = board.post(from, draft);
				if (outcome.ok && draft.kind === "result") posted.push(outcome.post.id);
				return outcome;
			},
			since: (reader, cursor, limit) => board.since(reader, cursor, limit),
			all: () => board.all(),
		},
		begin() {
			posted = [];
		},
	};
}
