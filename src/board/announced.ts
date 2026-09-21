/**
 * A board and a set of claims that say what they do, on the event bus.
 *
 * `board.ts` and `claims.ts` are pure data, and stay so. What a run needs
 * besides is that every act on them is recorded, whoever performed it - a
 * member through its tool, or the workflow handing a member what it has not
 * seen and taking back what a member that is gone was holding. Announcing from
 * the tool alone left the second half silent: the handout that fed every
 * round of a swarm was in nobody's record.
 *
 * So the announcement wraps the medium, once, and every caller is handed the
 * wrapped one. Posts answer who said what; reads answer who *knew* what, so a
 * read is announced with the ids it handed over and how many it left waiting,
 * the empty read included. A grant and a refusal are both facts of the run,
 * and so is every key given back for a member that stopped.
 */

import type { Board } from "./board.ts";
import type { Claims } from "./claims.ts";
import type { EventBus } from "../events.ts";

/** The same board, with every accepted post and every read on the bus. */
export function announcedBoard(board: Board, bus: EventBus): Board {
	return {
		post(from, draft) {
			const outcome = board.post(from, draft);
			// A refused post said nothing to anybody, so there is nothing to record.
			if (outcome.ok) bus.emit({ type: "post", id: from, post: outcome.post });
			return outcome;
		},
		since(reader, cursor, limit) {
			const reading = board.since(reader, cursor, limit);
			bus.emit({ type: "read", id: reader, posts: reading.posts.map((one) => one.id), waiting: reading.waiting });
			return reading;
		},
		all: () => board.all(),
	};
}

/** The same claims, with every grant, refusal and release on the bus. */
export function announcedClaims(claims: Claims, bus: EventBus): Claims {
	return {
		take(member, key) {
			const outcome = claims.take(member, key);
			bus.emit({ type: "claim", id: member, key, action: "take", ok: outcome.ok, ...(outcome.ok ? {} : { heldBy: outcome.heldBy }) });
			return outcome;
		},
		release(member, key) {
			// Who does hold it, before the refusal loses the fact: a record that
			// says only "refused" cannot tell "not yours" from "no such thing".
			const holder = claims.owner(key);
			const gone = claims.release(member, key);
			bus.emit({ type: "claim", id: member, key, action: "release", ok: gone, ...(gone || !holder ? {} : { heldBy: holder }) });
			return gone;
		},
		releaseAll(member) {
			const gone = claims.releaseAll(member);
			// One event per key: the record reads each thing given back, as it
			// reads each thing taken.
			for (const key of gone) bus.emit({ type: "claim", id: member, key, action: "release", ok: true });
			return gone;
		},
		owner: (key) => claims.owner(key),
		free: () => claims.free(),
		open: () => claims.open(),
	};
}
