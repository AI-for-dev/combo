/**
 * How a member reaches the board.
 *
 * One tool, `board`, built per member and closing over two things it therefore
 * never has to be told: which board, and who is calling. An agent whose `tools:`
 * does not name `board` is not given it by pi, so what a member can say stays
 * readable in its own file, the same way delegation does.
 *
 * **The member's id is in the closure, not in the parameters.** That is the
 * whole reason this file exists rather than the board being handed round: a
 * `from` a model can write is a `from` a model can borrow, and a medium where
 * anybody can post as anybody is not a record of anything.
 *
 * Every half goes onto the event bus, so a reporter sees the traffic as it
 * happens and `record.ts` writes it down beside everything else. **Reading is
 * announced as well as posting**, and that is not symmetry for its own sake:
 * the posts say who said what, and an investigation of a run asks who *knew*
 * what. Knowing comes from being handed something, so being handed something is
 * an event.
 *
 * When the caller gives it a {@link Claims}, the tool also grants and returns
 * things. That is a different act from posting a `claim`: a post announces into
 * a medium that was empty when the member looked, and a take is decided. Both
 * are offered, because a member still has to say what it is doing, and only one
 * of them settles who does it.
 */

import { Type } from "typebox";
import { boardLines, type Board, type PostKind } from "./board.ts";
import type { Claims } from "./claims.ts";
import type { EventBus } from "./events.ts";
import { defineTool, type ToolDefinition } from "./session.ts";

/** The name an agent writes in its `tools:` to be allowed on the board. */
export const BOARD_TOOL = "board";

/** The six {@link PostKind}s, in the order a member is offered them. */
const KINDS: readonly PostKind[] = ["ask", "tell", "result", "claim", "release", "hold"];

/**
 * How many posts one `read` hands back.
 *
 * A board holds hundreds and a member's context holds one conversation. Handing
 * over everything at once would spend on old traffic the room the work needs,
 * so a read is a page and the member is told when more is waiting. The cursor
 * only moves past what was actually given.
 */
const PAGE = 25;

/** Which board, on whose behalf, and where the traffic is announced. */
export type BoardToolOptions = {
	/** The one everybody is posting to. Shared; the cursor into it is not. */
	board: Board;
	/**
	 * The member holding this tool.
	 *
	 * Stamped on everything it posts. It is a parameter of the *builder*, never
	 * of the tool: whoever builds the tool knows who is holding it, and a model
	 * cannot reach a closure.
	 */
	from: string;
	/** Where a `post` event goes. Absent, the board still works and nobody watches. */
	bus?: EventBus;
	/**
	 * What there is to take, when anything is.
	 *
	 * Absent, the tool offers `post` and `read` only, and says so in its
	 * description: a member is never shown an action that would be refused
	 * whatever it asked for.
	 */
	claims?: Claims;
};

/** Whether an agent's definition asks to be allowed on the board. */
export function declaresBoard(tools: readonly string[] | undefined): boolean {
	return tools?.includes(BOARD_TOOL) ?? false;
}

/**
 * Builds the `board` tool for one member.
 *
 * Pass it through `SpawnOptions.customTools` in its function form: the member's
 * id is minted by `spawn`, so the tool cannot exist before the subagent does.
 *
 * Both halves refuse in prose the model can act on rather than failing silently.
 * A member told "the board is full" can spend its remaining turn on the work; a
 * member whose call vanished tries again.
 */
export function boardTool(options: BoardToolOptions): ToolDefinition {
	const { board, from, bus, claims } = options;
	// This member's place in the log, kept here because it is nobody else's
	// business: two members read at their own pace and neither waits for the
	// other.
	let cursor: string | undefined;

	return defineTool({
		name: BOARD_TOOL,
		label: "Board",
		description:
			"Leave a message for the others, or read what they have left. " +
			"Everyone works at the same time and nobody sees your context: the board is all they know of you. " +
			`Kinds: ${KINDS.join(", ")}.` +
			(claims ? " Before you start on something, `take` it: the first to ask holds it and everyone else is refused." : ""),
		promptSnippet: "Post to the board, or read what the others posted",
		parameters: Type.Object({
			action: Type.String({
				description: claims
					? '"take" to be given something to work on, "release" to give it back, "post" to say something, "read" to catch up.'
					: '"post" to say something, "read" to catch up.',
			}),
			kind: Type.Optional(Type.String({ description: `What the post is for. One of: ${KINDS.join(", ")}.` })),
			text: Type.Optional(Type.String({ description: "What you are saying. Required to post." })),
			to: Type.Optional(Type.String({ description: "One member. Left out, everybody reads it." })),
			key: Type.Optional(Type.String({ description: "The thing to take or release, named exactly." })),
		}),
		async execute(_toolCallId, params) {
			const action = params.action.trim().toLowerCase();
			if (action === "read") return said(read());
			if (action === "take" || action === "release") return grant(action, params.key?.trim() ?? "");
			if (action !== "post") {
				return refuse(`\`action\` is ${claims ? '"take", "release", "post" or "read"' : '"post" or "read"'}, not "${params.action}".`);
			}

			const text = params.text?.trim();
			if (!text) return refuse("A post says something: give `text`.");

			// A kind the schema allows but the board does not is refused rather
			// than guessed at. Filing a claim as a remark loses the one thing the
			// kind was for.
			const kind = params.kind?.trim().toLowerCase();
			if (!kind || !KINDS.includes(kind as PostKind)) {
				return refuse(`\`kind\` is one of: ${KINDS.join(", ")}. You sent ${kind ? `"${params.kind}"` : "nothing"}.`);
			}

			const outcome = board.post(from, { kind: kind as PostKind, text, ...(params.to ? { to: params.to.trim() } : {}) });
			if (!outcome.ok) return refuse(outcome.error);

			bus?.emit({ type: "post", id: from, post: outcome.post });
			return said(`Posted as ${outcome.post.id}.`);
		},
	});

	/**
	 * Being given a thing to work on, or giving it back.
	 *
	 * A refusal names the holder *and* what is still free, so one call is enough
	 * to move on: a member told only "taken" asks again for the next one it
	 * thought of, which is the race one level down.
	 */
	function grant(action: "take" | "release", key: string) {
		if (!claims) return refuse('There is nothing to take here: `action` is "post" or "read".');
		if (!key) return refuse("Name what you are taking: give `key`.");

		if (action === "release") {
			// Who does hold it, before the refusal loses the fact: a record that
			// says only "refused" cannot tell "not yours" from "no such thing".
			const holder = claims.owner(key);
			const gone = claims.release(from, key);
			bus?.emit({ type: "claim", id: from, key, action, ok: gone, ...(gone || !holder ? {} : { heldBy: holder }) });
			return gone ? said(`Gave up ${key}.`) : refuse(`You are not holding \`${key}\`${holder ? ` - ${holder} is` : ""}.`);
		}

		const outcome = claims.take(from, key);
		bus?.emit({ type: "claim", id: from, key, action, ok: outcome.ok, ...(outcome.ok ? {} : { heldBy: outcome.heldBy }) });
		if (outcome.ok) return said(`${key} is yours. Release it when you are done.`);
		return refuse(`${outcome.error}${remaining()}`);
	}

	/** What is still there to take, when the caller said what there was. */
	function remaining(): string {
		const free = claims?.free();
		if (free === undefined) return "";
		return free.length ? `. Still free: ${free.join(", ")}` : ". Nothing is free.";
	}

	/** What is new for this member, a page at a time. */
	function read(): string {
		const reading = board.since(from, cursor);
		const page = reading.posts.slice(0, PAGE);
		const waiting = reading.posts.length - page.length;

		// Past what was handed over, never past what was merely looked at: a post
		// left for the next page must still be there when the member asks again.
		cursor = page.at(-1)?.id ?? reading.cursor;

		// Every read, the empty ones included: "it looked and there was nothing"
		// is the only thing that settles what a member could not have known.
		bus?.emit({ type: "read", id: from, posts: page.map((one) => one.id), waiting });

		if (page.length === 0) return "Nothing new on the board.";
		return waiting > 0 ? `${boardLines(page)}\n\n(${waiting} more waiting - read again.)` : boardLines(page);
	}
}

/** An answer the model reads as an answer. */
function said(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

/** A refusal the model can act on, rather than a failure it has to guess at. */
function refuse(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}
