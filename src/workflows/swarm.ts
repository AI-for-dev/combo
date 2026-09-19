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
import { boardTool } from "./../board-tool.ts";
import { boardLines, createBoard, type Board, type Post } from "./../board.ts";
import { createClaims, type Claims } from "./../claims.ts";
import { busFor } from "./../events.ts";
import { failed, type Result } from "./../result.ts";
import { sumUsage, type Usage } from "./../usage.ts";
import type { Subagent } from "./../subagent.ts";
import { mapConcurrent, SubagentPool, type WorkflowOptions } from "./common.ts";

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
};

/** What the swarm did, and what it left behind. */
export type SwarmResult = {
	/** One per member, in roster order, the ones that failed included. */
	members: readonly SwarmMember[];
	/** Every post, in order. The run's social history. */
	posts: readonly Post[];
	/** What was taken, and what was still held when its holder stopped. */
	claims: readonly SwarmClaim[];
	/** How many rounds actually ran. */
	rounds: number;
	/** Every turn of every member, over the swarm's own wall time. */
	usage: Usage;
	/** Whether `until` fired. Reaching the round cap is not success. */
	converged: boolean;
	/** Which cap ended it. */
	stoppedBy: SwarmEnd;
	/** Every member ran every round it was asked to, without a model error. */
	ok: boolean;
	/** The first failure, when there was one. */
	error?: string;
};

/**
 * Runs a swarm.
 *
 * A round is one `ask` per live member, through `mapConcurrent`. A member whose
 * turn fails drops out rather than costing every remaining round, and keeps the
 * turn that failed as its result.
 *
 * The pool closes everything in a `finally`, cancellation included, and the
 * claims of whoever is gone are released before the result is built.
 */
export async function swarm(options: SwarmOptions): Promise<SwarmResult> {
	const { goal, signal, timeoutMs, until } = options;
	const rounds = options.rounds ?? 3;
	const lifetime = options.lifetime ?? "workflow";
	if (rounds < 1) throw new Error(`swarm: \`rounds\` must be at least 1, got ${rounds}`);
	// A member's id is its name on the board. A `"task"` member is a new subagent
	// with a new id every round, so from the second one nobody would be talking to
	// who they think they are.
	if (lifetime === "task" && rounds > 1) {
		throw new Error(`swarm: \`lifetime: "task"\` gives a member a new id each round, which is a new name on the board - use one round, or let members remember`);
	}

	const roster = options.members.flatMap(({ agent, count }) => Array.from({ length: Math.max(0, count) }, () => agent));
	if (roster.length === 0) throw new Error("swarm: give it at least one member");

	const board = options.board ?? createBoard();
	const claims = options.claims ?? createClaims();
	const concurrency = Math.max(1, options.concurrency ?? 4);
	const startedAt = performance.now();
	// The members and the board report on one stream, and the pool would open a
	// second one of its own if it were handed `onEvent` again.
	const bus = busFor(options);
	const pool = new SubagentPool({
		...options,
		bus,
		onEvent: undefined,
		lifetime,
		// Every member is handed the board under its own name. The id exists only
		// once the subagent does, which is what the function form is for.
		customTools: (agent) => (id: string) => [
			...(options.customTools?.(agent) as never[] | undefined ?? []),
			boardTool({ board, from: id, claims, bus }),
		],
	});

	const steps: Result[] = [];
	let converged = false;
	let stoppedBy: SwarmEnd = "rounds";
	let ran = 0;
	let members: Member[] = [];

	try {
		// Everyone at once, bounded: the ids have to exist before anybody can be
		// addressed, and a member spawned in round two would arrive after the work
		// was divided.
		members = await mapConcurrent(roster, concurrency, async (agent, index) => {
			const subagent = await pool.acquire(agent, `${agent.name}@${index}`);
			return { id: subagent.id, agent, ask: subagent.ask.bind(subagent) };
		});

		for (let round = 1; round <= rounds; round++) {
			if (signal?.aborted) {
				stoppedBy = "signal";
				break;
			}

			// A member whose turn failed drops out rather than costing every
			// remaining round, and keeps the turn that failed as its answer.
			const asking = members.filter((one) => round === 1 || one.result?.ok);
			if (asking.length === 0) {
				stoppedBy = "members";
				break;
			}

			ran = round;
			await mapConcurrent(asking, concurrency, async (member) => {
				const reading = board.since(member.id, member.cursor);
				member.cursor = reading.cursor;
				member.result = await member.ask(task(goal, round, reading.posts, claims), { signal, timeoutMs });
				steps.push(member.result);
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
	const broke = members.find((one) => one.result && !one.result.ok);

	return {
		members: members.map((one) => ({
			id: one.id,
			agent: one.agent.name,
			result: one.result ?? failed(one.agent.name, "never asked"),
		})),
		posts: board.all(),
		claims: held.map((one) => ({ ...one, released: released.has(one.key) })),
		rounds: ran,
		usage: sumUsage(
			steps.map((step) => step.usage),
			performance.now() - startedAt,
		),
		converged,
		stoppedBy,
		ok: members.length > 0 && members.every((one) => one.result?.ok === true),
		...(broke?.result?.error ? { error: broke.result.error } : {}),
	};
}

/** A member, while the swarm runs: who it is, where it has read to, what it last said. */
type Member = {
	id: string;
	agent: Agent;
	ask: Subagent["ask"];
	cursor?: string;
	result?: Result;
};

/**
 * What one member is told this round.
 *
 * The goal every time, because a member is not asked to remember its brief; the
 * board's news only when there is some, because a line saying nothing happened
 * is a line spent saying nothing.
 */
export function task(goal: string, round: number, posts: readonly Post[], claims: Claims): string {
	const free = claims.free();
	return [
		goal,
		"",
		posts.length > 0 ? `Since your last turn, on the board:\n${boardLines(posts)}\n` : "",
		free && free.length > 0 ? `Still free to take: ${free.join(", ")}.\n` : "",
		round === 1
			? "Others are on this at the same time. Take what you will work on before you start."
			: `Round ${round}. Carry on, or take something else if what you had is done.`,
	]
		.filter(Boolean)
		.join("\n");
}
