/**
 * What a swarm tells one member at the top of each turn.
 *
 * Apart from `swarm.ts`, which decides who is asked and when: this is the
 * wording, and the only part of a round a model reads. It is where a change to
 * how members behave is usually made, and it is tested on its own for that.
 */

import { boardLines, type Claims, type Post } from "../board/index.ts";

/**
 * What one member is told this round.
 *
 * The goal every time, because a member is not asked to remember its brief; the
 * board's news only when there is some, because a line saying nothing happened
 * is a line spent saying nothing. Given the `reader`, what answers its posts
 * comes first.
 */
export function swarmTask(goal: string, round: number, posts: readonly Post[], claims: Claims, reader?: string): string {
	const free = claims.free();
	return [
		goal,
		"",
		posts.length > 0 ? `Since your last turn, on the board:\n${boardLines(posts, reader)}\n` : "",
		free && free.length > 0 ? `Still free to take: ${free.join(", ")}.\n` : "",
		round === 1
			? "Others are on this at the same time. Take what you will work on before you start."
			: `Round ${round}. Carry on, or take something else if what you had is done.`,
		"What the others post while you work reaches you at the top of your next turn, so there is no need to wait for it.",
	]
		.filter(Boolean)
		.join("\n");
}
