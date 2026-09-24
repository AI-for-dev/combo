/**
 * Several members on one job, for as many rounds as you allow.
 *
 * Every other combinator here decides who does what: `fanOut` hands out the
 * subtasks, `orchestrate` has a planner write them, `chain` fixes the order.
 * A swarm decides none of it. The members are told the same goal, given a
 * {@link Board} to talk on and a {@link Claims} to take work from, and what
 * they divide between them is theirs.
 *
 * That makes it the one combinator whose value is an open question, so it is
 * built to be compared against the thing it might not beat: **with no board, no
 * claims and one round, a swarm is a fan-out**. That degenerate case is a test,
 * and it is the control arm of any experiment run with this.
 *
 * Three things are decided here rather than left to a prompt, each one measured
 * on a run before it was written down:
 *
 * - **Members remember.** `lifetime` defaults to `"workflow"` here and nowhere
 *   else. A member that forgets the last round cannot build on what it saw, and
 *   a swarm of amnesiacs is a fan-out that costs more.
 * - **What is new is handed over, not fetched.** A member is given what the
 *   board has for it at the top of its task. Measured: given something that
 *   arbitrates, members stopped reading the board entirely - they take, they are
 *   refused, they take something else. Making them spend a call to find out what
 *   happened would be charging them for the workflow's bookkeeping.
 * - **A member that is gone holds nothing.** Whatever it still had is released
 *   when it drops out or when the swarm ends, and the result says what that was.
 *   Measured: two of three members never released what they took, and claims
 *   left by a member that has closed are work nobody will do and nobody can
 *   take.
 */

import type { Agent } from "./../agent.ts";
import {
	announcedBoard,
	announcedClaims,
	boardLines,
	boardTool,
	createBoard,
	createClaims,
	createReader,
	turnBoard,
	type Board,
	type Claims,
	type Post,
	type Reader,
	type TurnBoard,
} from "../board/index.ts";
import { busFor } from "./../events.ts";
import { failed, joinOutputs, type Result, type WorkflowResult } from "./../result.ts";
import { mapConcurrent } from "./concurrent.ts";
import { offerBoth, type WorkflowOptions } from "./options.ts";
import { type Held, SubagentPool } from "./pool.ts";

/**
 * Failed turns in a row that take a member out of the swarm.
 *
 * Two, so a failed turn is asked again once, the rule every agent node of the
 * shipped flows follows. Measured in a real pi: a debater cut by the output
 * limit in the first round dropped out, and an agreement that needed its vote
 * could not happen in any of the three rounds still paid for.
 */
const DROPPED_AFTER = 2;

/** How many of one agent stand on the board. A swarm of one is a run. */
export type MemberSpec = {
	/** Whose copies these are. */
	agent: Agent;
	/** How many copies of it. Each gets its own id, its own memory, its own place. */
	count: number;
};

/** One member, and the last thing it said. */
export type SwarmMember = {
	/** The subagent id, which is also the name it posts and claims under. */
	id: string;
	/** Which agent it is a copy of. */
	agent: string;
	/** Its last turn. A member that dropped out early keeps the turn that failed. */
	result: Result;
};

/** What a member was holding when it stopped, and whether anyone took it back. */
export type SwarmClaim = {
	/** The thing that was taken. */
	key: string;
	/** The member that had it when the swarm ended. */
	heldBy: string;
	/** True when the swarm released it because the member was gone. */
	released: boolean;
};

/** Why the swarm stopped, apart from whether it went well. */
export type SwarmEnd = "until" | "rounds" | "members" | "signal";

/** Who is on it, what they are told, and how long they have. */
export type SwarmOptions = WorkflowOptions & {
	/** Who is on it, and how many of each. */
	members: readonly MemberSpec[];
	/** The one thing every member is told. Broad enough to admit several routes. */
	goal: string;
	/** Turns per member. Defaults to 3, because "forever" must not be reachable. */
	rounds?: number;
	/** Members asked at once. Defaults to 4. */
	concurrency?: number;
	/** Defaults to a fresh in-memory board. Pass one to read it afterwards. */
	board?: Board;
	/** What there is to take. Absent, the members are on their honour. */
	claims?: Claims;
	/** Has the goal been reached? Read from the board, after every round. */
	until?: (board: Board) => boolean;
	/**
	 * How many `result`s a member may post in one turn. Absent, as many as the
	 * board takes: a member describing files posts one per file. A debate wants
	 * 1, because a vote posted again is not an argument.
	 */
	resultsPerTurn?: number;
};

/**
 * What the swarm did, and what it left behind.
 *
 * As a `Result`: every member's last turn, labelled by the name it posted
 * under, a failed one marked as such; `ok` is false when any member failed or
 * was never asked, `error` the first failure's. `steps` is every turn of every
 * round, and `usage` their sum over the swarm's own wall time.
 */
export type SwarmResult = WorkflowResult & {
	/** One per member, in roster order, the ones that failed included. */
	members: readonly SwarmMember[];
	/** Every post, in order. The run's social history. */
	posts: readonly Post[];
	/** What was taken, and what was still held when its holder stopped. */
	claims: readonly SwarmClaim[];
	/** How many rounds actually ran. */
	rounds: number;
	/** Whether `until` fired. Reaching the round cap is not success. */
	converged: boolean;
	/** Which cap ended it. */
	stoppedBy: SwarmEnd;
};

/**
 * Runs a swarm.
 *
 * A round is one `ask` per live member, through `mapConcurrent`. A member whose
 * turn fails is asked again the next round; two failed turns in a row and it
 * drops out rather than costing every remaining round, keeping the turn that
 * failed as its result.
 *
 * The pool closes everything in a `finally`, cancellation included, and the
 * claims of whoever is gone are released before the result is built.
 */
export async function swarm(options: SwarmOptions): Promise<SwarmResult> {
	const { goal, signal, until } = options;
	const rounds = options.rounds ?? 3;
	const lifetime = options.lifetime ?? "workflow";
	if (rounds < 1) throw new Error(`swarm: \`rounds\` must be at least 1, got ${rounds}`);
	const { resultsPerTurn } = options;
	if (resultsPerTurn !== undefined && !(resultsPerTurn >= 1)) {
		throw new Error(`swarm: \`resultsPerTurn\` must be at least 1, got ${resultsPerTurn}`);
	}
	// A member's id is its name on the board. A `"task"` member is a new subagent
	// with a new id every round, so from the second one nobody would be talking to
	// who they think they are.
	if (lifetime === "task" && rounds > 1) {
		throw new Error(`swarm: \`lifetime: "task"\` gives a member a new id each round, which is a new name on the board - use one round, or let members remember`);
	}

	const roster = options.members.flatMap(({ agent, count }) => Array.from({ length: Math.max(0, count) }, () => agent));
	if (roster.length === 0) throw new Error("swarm: give it at least one member");

	const concurrency = Math.max(1, options.concurrency ?? 4);
	// The members and the board report on one stream, and the pool would open a
	// second one of its own if it were handed `onEvent` again.
	const bus = busFor(options);
	// Wrapped here, whoever built them: what a member does through its tool and
	// what this workflow does for it - the handout each round, the keys taken
	// back from a member that is gone - land in the same record.
	const board = announcedBoard(options.board ?? createBoard(), bus);
	const claims = announcedClaims(options.claims ?? createClaims(), bus);
	// Each member's place on the board: one cursor, for the handout and its own
	// `read` alike, and the count of what it posted this turn.
	const seats = new Map<string, Seat>();
	const seatOf = (id: string): Seat => {
		let seat = seats.get(id);
		if (!seat) {
			seat = { reader: createReader(board, id), ...(resultsPerTurn === undefined ? {} : { turn: turnBoard(board, resultsPerTurn) }) };
			seats.set(id, seat);
		}
		return seat;
	};
	const pool = new SubagentPool({
		...options,
		bus,
		onEvent: undefined,
		lifetime,
		// Every member is handed the board under its own name, beside whatever the
		// caller offered it. The id exists only once the subagent does, which is
		// what the function form is for.
		customTools: offerBoth(options.customTools, () => (id: string) => {
			const { reader, turn } = seatOf(id);
			return [boardTool({ board: turn?.board ?? board, from: id, claims, reader })];
		}),
	});

	let converged = false;
	let stoppedBy: SwarmEnd = "rounds";
	let ran = 0;
	let members: Member[] = [];

	try {
		// Everyone at once, bounded: the ids have to exist before anybody can be
		// addressed, and a member spawned in round two would arrive after the work
		// was divided. A swarm already called off holds nobody: the pool refuses.
		members = await mapConcurrent(roster, concurrency, async (agent, index) => ({
			...(await pool.hold(agent, { key: `${agent.name}@${index}` })),
			agent,
			failures: 0,
		}));

		for (let round = 1; round <= rounds; round++) {
			if (signal?.aborted) {
				stoppedBy = "signal";
				break;
			}

			// A failed turn is asked again once, the next round. Two in a row and the
			// member drops out rather than costing every remaining round, keeping the
			// turn that failed as its answer.
			const asking = members.filter((one) => one.failures < DROPPED_AFTER);
			if (asking.length === 0) {
				stoppedBy = "members";
				break;
			}

			ran = round;
			await mapConcurrent(asking, concurrency, async (member) => {
				const seat = seatOf(member.id);
				seat.turn?.begin();
				member.result = await member.ask(task(goal, round, seat.reader.next().posts, claims, member.id));
				member.failures = member.result.ok ? 0 : member.failures + 1;
			});

			if (until?.(board)) {
				converged = true;
				stoppedBy = "until";
				break;
			}
		}
	} finally {
		await pool.closeAll();
	}

	// Whoever is gone holds nothing: a claim left by a closed member is work
	// nobody will do and nobody can take.
	const held = claims.open();
	const released = new Set(members.flatMap((one) => claims.releaseAll(one.id)));
	const reported: SwarmMember[] = members.map((one) => ({ id: one.id, agent: one.agent.name, result: one.result ?? failed(one.agent.name, "never asked") }));
	// The member that speaks for the whole: the first that failed, else the last
	// on the roster. Under the name it posted under, which is how the others
	// know it and how a reader finds it on the board.
	const voice = (reported.find((one) => !one.result.ok) ?? reported.at(-1)) as SwarmMember;

	return {
		...voice.result,
		output: membersOutput(reported),
		steps: pool.trail.steps,
		members: reported,
		posts: board.all(),
		claims: held.map((one) => ({ ...one, released: released.has(one.key) })),
		rounds: ran,
		usage: pool.trail.usage(),
		converged,
		stoppedBy,
		// Every member, not every turn: one that was never asked failed the swarm
		// too. The error is the voice's own, carried by the spread above.
		ok: reported.every((one) => one.result.ok),
	};
}

/**
 * What every member last said, under the name it posted under.
 *
 * The id and not the agent, because three copies of one agent share the name
 * and a reader finds a member on the board by its id.
 */
export function membersOutput(members: readonly SwarmMember[]): string {
	return joinOutputs(members.map((one) => ({ ...one.result, agent: one.id })));
}

/** Where a member reads from, and what it may still post this turn. */
type Seat = { reader: Reader; turn?: TurnBoard };

/** A member, while the swarm runs: who it is, and what it last said. */
type Member = Held & {
	agent: Agent;
	/** Its failed turns in a row. */
	failures: number;
	result?: Result;
};

/**
 * What one member is told this round.
 *
 * The goal every time, because a member is not asked to remember its brief; the
 * board's news only when there is some, because a line saying nothing happened
 * is a line spent saying nothing. Given the `reader`, what answers its posts
 * comes first.
 */
export function task(goal: string, round: number, posts: readonly Post[], claims: Claims, reader?: string): string {
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
