/**
 * The board: a shared, append-only medium where a swarm's members see each
 * other, and the arbiter that lets them divide work nobody assigned.
 *
 * This is the module's door. `swarm` builds a board and its claims, wraps
 * them so the bus hears every post, and hands each member the tool; the
 * `/swarm` command reads the vote, and `examples/16-debate.ts` prints who
 * voted for what.
 */

export { agreed, latestVotes, VOTE_INSTRUCTION } from "./agreement.ts";
export { announcedBoard, announcedClaims } from "./announced.ts";
export {
	boardLines,
	createBoard,
	type Board,
	type BoardLimits,
	type BoardOptions,
	type Draft,
	type Post,
	type PostKind,
	type PostOutcome,
	type Reading,
} from "./board.ts";
export { createClaims, heldList, type Claims, type ClaimsOptions, type Holding, type TakeOutcome } from "./claims.ts";
export { createReader, type Reader } from "./reader.ts";
export { boardTool, declaresBoard, type BoardToolOptions } from "./tool.ts";
