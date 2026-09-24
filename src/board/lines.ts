/**
 * The board as a member reads it: one line per post, and what answers the
 * reader first.
 *
 * Apart from `board.ts`, which is the medium and says nothing about how it is
 * shown. Every place that hands a member posts goes through here - the
 * swarm's handout, the tool's `read`, `/swarm`'s summary - so a post reads the
 * same wherever a member meets it.
 */

import type { Post } from "./board.ts";

/**
 * Posts as a member reads them: who, to whom, answering what, what kind, what
 * it said.
 *
 * Given the `reader`, what answers its own posts comes first, under a line that
 * says so. A debater handed ten posts reads the first few, and the ones that
 * are its business are the ones that answer it.
 */
export function boardLines(posts: readonly Post[], reader?: string): string {
	const answering = reader ? posts.filter((one) => one.re?.from === reader) : [];
	if (answering.length === 0) return posts.map(postLine).join("\n");
	const rest = posts.filter((one) => !answering.includes(one));
	return ["Answering you:", ...answering.map(postLine), ...(rest.length ? ["", "The rest:", ...rest.map(postLine)] : [])].join("\n");
}

/** One post, on one line. */
function postLine(post: Post): string {
	const to = post.to ? ` → ${post.to}` : "";
	const re = post.re ? ` re ${post.re.id} (${post.re.from})` : "";
	return `${post.id} ${post.from}${to}${re} [${post.kind}] ${post.text}`;
}
