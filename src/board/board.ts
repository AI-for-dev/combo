/**
 * A place several subagents can leave messages for each other.
 *
 * Everything else here passes `Result`s between subagents that never meet. A
 * board is the other arrangement: members that can see each other, and can
 * therefore divide work nobody assigned them. It is worth building only if it
 * can be watched, which is what this file is for - an append-only log, in
 * memory, with no pi and no disk, so a run that used one can be read back
 * afterwards exactly as it happened.
 *
 * Three rules, each one a property the medium has to have rather than a
 * preference:
 *
 * - **Nothing is rewritten and nothing is deleted.** A member can add to the
 *   record and that is all it can do to it. Agents given a record they could
 *   edit have been observed going looking for ways to edit it, and an
 *   investigation of a run is worth nothing if the run could rewrite it.
 * - **`from` is stamped, never declared.** The caller says who is posting; no
 *   field of the draft carries it. Identity being claimable is what makes a
 *   shared medium unauthenticated, and an unauthenticated medium is one where
 *   a member can speak as another. The same discipline as "only whoever raised
 *   an obligation may close it".
 * - **The caps ship with the board.** All three have defaults, for the reason
 *   `maxIterations` does: a medium with no limit produces as many messages as
 *   the run has time for, and the only number nobody chose is "as many as it
 *   takes".
 *
 * And one refusal that is not a cap: **a member does not say again exactly what
 * it already said**, same kind, same reader, same words. The copy tells nobody
 * anything new and costs every reader a slot on its page. It was measured: a
 * member told to post once a turn posted one vote six times in a single turn.
 *
 * What it deliberately is not: a queue, a channel with delivery guarantees, or
 * anything a member can read twice by accident. {@link Board.since} hands a
 * reader what it has not been given yet and a cursor to ask again with, so the
 * bookkeeping of "who has seen what" lives here and not in a workflow.
 */

/**
 * What a post is for, so a reader can tell traffic apart without parsing prose.
 *
 * Six and not more: each one is something a member does that another member has
 * to react to differently. A seventh is added when a run needs it.
 */
export type PostKind = "ask" | "tell" | "result" | "claim" | "release" | "hold";

/** One message, as it will be read back a year later. */
export type Post = {
	/** Assigned here, stable, never rewritten. */
	readonly id: string;
	/** The member that posted it. Stamped by the board, never taken from a draft. */
	readonly from: string;
	/** The member it is for. Absent means everyone. */
	readonly to?: string;
	/** What it is for, so a reader can sort traffic without reading it. */
	readonly kind: PostKind;
	/** What it says, trimmed. Never rewritten afterwards. */
	readonly text: string;
	/** Milliseconds since the board opened. Ours, and monotonic. */
	readonly at: number;
};

/** A post as a member writes it: what it says, and who for. */
export type Draft = {
	/** What this post is for. */
	kind: PostKind;
	/** What it says. Empty is refused: a post with nothing in it is noise. */
	text: string;
	/** Who it is for. Left out, everyone reads it. */
	to?: string;
};

/** A post that went up, or why it did not. */
export type PostOutcome = { ok: true; post: Post } | { ok: false; error: string };

/** What a reader has not been given yet, and what to ask with next time. */
export type Reading = {
	/** What came in since the cursor, for this reader only - up to the limit asked for. */
	posts: readonly Post[];
	/** Pass it back to {@link Board.since} to be given only what came after. */
	cursor: string;
	/** How many more were there for this reader, past the limit. `0` when it was handed everything. */
	waiting: number;
};

/**
 * How much a board will hold.
 *
 * Each default is a number somebody chose, which is the whole point of them
 * being here: a board with no cap is one where a loop between two members is
 * bounded by the deadline and nothing else.
 */
export type BoardLimits = {
	/** Total posts before the board refuses. Default 200. */
	maxPosts?: number;
	/** Longest a single post may be. Default 2000 characters. */
	maxPostChars?: number;
	/** How many one member may post. Default 50. */
	maxPostsPerMember?: number;
};

/** The medium. Append, and read what you have not read. */
export type Board = {
	/**
	 * Posts as `from`, or refuses and says why.
	 *
	 * A refusal is an outcome the caller reports to the member, never a throw:
	 * a member that hits a cap has to be told which one, so it can do something
	 * else with the turn it has left.
	 */
	post(from: string, draft: Draft): PostOutcome;
	/**
	 * What `reader` has not been given: everyone's broadcasts, plus its own mail.
	 *
	 * `limit` is a page: a board holds hundreds and a member's context holds one
	 * conversation, so a reader may ask for a few and be told how many wait. The
	 * cursor then moves past what was handed over, never past what was merely
	 * looked at, so a post left for the next page is still there when asked.
	 */
	since(reader: string, cursor?: string, limit?: number): Reading;
	/** Every post, in the order they went up. The record an investigation reads. */
	all(): readonly Post[];
};

/** Who is on the board, and how much it will hold. */
export type BoardOptions = {
	/**
	 * The members, so a post addressed to nobody can be refused.
	 *
	 * Left out, the board does not know who is on it and accepts any `to`. That
	 * is the honest behaviour rather than a convenience: refusing an address it
	 * cannot check would be guessing.
	 */
	members?: readonly string[];
	/** What it will hold. Left out, the defaults apply; there is no way to say "no cap". */
	limits?: BoardLimits;
};

const DEFAULTS = { maxPosts: 200, maxPostChars: 2000, maxPostsPerMember: 50 } as const;

/**
 * An empty board.
 *
 * `at` is measured from here on a monotonic clock, so the record says how far
 * into the run each post went up. Wall-clock time is the operator's business
 * and changes under a run; the distance between two posts does not.
 */
export function createBoard(options: BoardOptions = {}): Board {
	const limits = { ...DEFAULTS, ...options.limits };
	const members = options.members ? new Set(options.members) : undefined;
	const posts: Post[] = [];
	const openedAt = performance.now();
	const countFor = new Map<string, number>();
	// Each thing a member said, under the id it was first said as.
	const said = new Map<string, string>();

	return {
		post(from, draft) {
			const text = draft.text.trim();
			if (!text) return { ok: false, error: "a post says something: `text` was empty" };
			if (text.length > limits.maxPostChars) {
				return { ok: false, error: `that post is ${text.length} characters, and the board takes ${limits.maxPostChars}` };
			}
			if (posts.length >= limits.maxPosts) {
				return { ok: false, error: `the board is full at ${limits.maxPosts} posts: it takes no more, whatever they say` };
			}
			const mine = countFor.get(from) ?? 0;
			if (mine >= limits.maxPostsPerMember) {
				return { ok: false, error: `you have posted ${mine} times, which is all ${from} gets` };
			}
			if (draft.to && members && !members.has(draft.to)) {
				return { ok: false, error: `nobody here is called \`${draft.to}\` - the board has ${[...members].join(", ")}` };
			}
			const saying = JSON.stringify([from, draft.kind, draft.to ?? "", text]);
			const before = said.get(saying);
			if (before) return { ok: false, error: `you already posted that as ${before}: say something new, or nothing` };

			const post: Post = {
				id: `p${posts.length + 1}`,
				from,
				kind: draft.kind,
				text,
				at: Math.round(performance.now() - openedAt),
				...(draft.to ? { to: draft.to } : {}),
			};
			posts.push(post);
			countFor.set(from, mine + 1);
			said.set(saying, post.id);
			return { ok: true, post };
		},

		since(reader, cursor, limit) {
			const from = cursor ? Number(cursor.slice(1)) || 0 : 0;
			// A member has read what it wrote. Handing it back would spend the
			// context it is meant to save.
			const mine = posts.slice(from).filter((one) => one.from !== reader && (one.to === undefined || one.to === reader));
			const page = limit === undefined ? mine : mine.slice(0, Math.max(0, limit));
			const waiting = mine.length - page.length;
			// With everything handed over, the cursor is the last post that existed
			// when this reader looked, not the last it was handed: a post for
			// somebody else must not be re-examined on every read. With a page left
			// behind, it is the last post handed, so the rest is still there.
			const last = waiting > 0 ? (page.at(-1)?.id as string) : posts.length > 0 ? `p${posts.length}` : (cursor ?? "");
			return { posts: page, cursor: last, waiting };
		},

		all() {
			return posts;
		},
	};
}

/** Posts as a member reads them: who, to whom, what kind, what it said. */
export function boardLines(posts: readonly Post[]): string {
	return posts.map((one) => `${one.id} ${one.from}${one.to ? ` → ${one.to}` : ""} [${one.kind}] ${one.text}`).join("\n");
}
