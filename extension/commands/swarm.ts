/**
 * `/swarm`: several copies of one agent on one job, from inside pi.
 *
 * Every other command here decides who does what - `/run` walks a flow,
 * whose planner may write the split, and `/step` names the agent itself. A
 * swarm decides none of it: the members are told the same thing, handed a board
 * to talk on and, when the caller names what there is, a set of claims to take
 * work from. What they divide between them is theirs.
 *
 * It arrived last on purpose. The library ran first, from `examples/15-swarm.ts`,
 * and what those runs said is written into `docs/guide/swarm.md`: on work one
 * member could finish, a board earns nothing. The command exists because
 * watching one is how anybody decides whether their own job is that kind.
 *
 * **A swarm is a step of the chain**, recorded in the relay like `/step`'s own:
 * the answer is drawn in the transcript and stays out of the model's context,
 * `/quote` is the door into the conversation, and `/step --from` carries it on.
 * A board pasted into a session would turn the window into an orchestrator
 * nobody asked for, and it is long.
 */

import {
	agreed,
	boardLines,
	createClaims,
	declaresBoard,
	findAgent,
	membersOutput,
	parseDuration,
	plural,
	type Agent,
	type Board,
	type Claims,
	type MemberSpec,
	type SwarmResult,
	VOTE_INSTRUCTION,
} from "../../src/index.ts";
import { checked, loadRoster, refuse, watched } from "../command.ts";
import { sessionDoors, type CommandCtx, type PiApi } from "../pi.ts";
import { resolved, type StepDeps } from "../deps.ts";
import { parseLeadingFlags } from "../flags.ts";
import { beginStep, finishStep, type RelayStep } from "../relay.ts";
import { shown } from "./answer.ts";

/** The agent a swarm is made of when the command is not told otherwise. */
export const DEFAULT_MEMBER = "member";

/** How many copies stand on the board when the command is not told otherwise. */
export const DEFAULT_MEMBERS = 3;

/**
 * How long one member's turn may take when `--timeout` does not say.
 *
 * The library picks no deadline, and a command has to: pi's agent loop has no
 * step cap, and a member can spend its turn reading a board nobody is posting
 * to. Measured with gemma-4-31b on a three-way debate: three runs with no
 * deadline went past twenty-five minutes, one of them past forty, and left
 * nothing to read, since a swarm exports its transcripts when it ends. Five
 * minutes is the bound `/interview` gives its turns, for the same reason.
 */
export const SWARM_TURN_MS = 300_000;

/** Registers `/swarm`. */
export default function registerSwarmCommand(pi: PiApi) {
	const deps = sessionDoors(pi);

	pi.registerCommand("swarm", {
		description:
			"Put several agents on one job, with a board between them: copies of one (`--agent <name>`, `--members <n>`) or one of each (`--agent a,b,c`); `--claim a,b`, `--hold <n>`, `--until agree`, `--rounds <n>`, `--timeout <duration>`, `--model <pattern>`",
		handler: async (args, ctx: CommandCtx) => {
			await runSwarm(args, ctx, deps);
		},
	});
}

/**
 * `/swarm [--members <n>] [--claim a,b,c] [--hold <n>] [--until agree] [--rounds <n>] [--agent <name>[,<name>…]] [--timeout <duration>] [--model <pattern>] <goal>`.
 *
 * `--agent` names one agent, put on the board `--members` times, or several,
 * put on it once each. Copies of one agent share one brief, so a side to open
 * for can only be handed out on the board, and a member refused the side it
 * asked for has been seen taking no other. Several agents carry their sides in
 * their own files, which is where a debate's disagreement has to come from.
 *
 * `--claim` is what turns announcing into holding: named, the things are leased
 * one owner at a time and a second member is refused and told who has it.
 * Without it the members are on their honour, which a run showed is a race
 * whatever the prompt says.
 *
 * `--until agree` is the other thing a swarm can be finished by. Default, a run
 * is done when every named thing has been reported on, which is coverage and
 * suits a job that splits. A job that does not split has no coverage to reach:
 * put three members on one question and what ends it is the three of them
 * saying the same thing. The two compose, and a debate wants both - the claims
 * hand out the opening positions, agreement stops it.
 */
export async function runSwarm(args: string, ctx: CommandCtx, injected: StepDeps): Promise<RelayStep | undefined> {
	const deps = resolved(injected);
	const { flags, rest: goal, refused } = parseLeadingFlags(args, ["claim", "agent", "model", "until", "timeout"], { counts: ["members", "rounds", "hold"] });
	if (refused) return refuse(ctx, `swarm: ${refused}`, "warning");
	if (!goal.trim()) {
		return refuse(ctx, "swarm: say what they are all on, for example /swarm describe every file under src/reporters/", "warning");
	}

	// `--claim a.ts, b.ts` reads as one key and two words of goal, because a flag
	// value stops at the first space everywhere in pi. Silently running on the
	// wrong list is the worst of the three ways out, so the comma is caught.
	for (const flag of ["claim", "agent"] as const) {
		if (flags[flag]?.endsWith(",")) {
			return refuse(ctx, `swarm: --${flag} takes one comma-separated list with no spaces, for example --${flag} a,b`, "warning");
		}
	}
	const names = keysFrom(flags.agent ?? DEFAULT_MEMBER);
	const twice = names.find((name, index) => names.indexOf(name) !== index);
	if (twice) return refuse(ctx, `swarm: --agent names ${twice} twice - --members puts copies of one agent on the board`, "warning");
	if (names.length > 1 && flags.members !== undefined) {
		return refuse(ctx, "swarm: --members counts copies of one agent - with several in --agent, each stands on the board once", "warning");
	}

	const timeoutMs = flags.timeout === undefined ? SWARM_TURN_MS : parseDuration(flags.timeout);
	if (timeoutMs === undefined) return refuse(ctx, "swarm: --timeout takes a duration written 90s, 10m or 1h", "warning");

	const cast = await checked(ctx, async () => {
		const roster = loadRoster(ctx, deps);
		const agents = names.map((name) => findAgent(roster, name));
		const count = names.length > 1 ? 1 : (whole(flags.members) ?? DEFAULT_MEMBERS);
		const rounds = whole(flags.rounds);
		if (flags.model) await deps.checkModel(flags.model);
		return { agents, count, rounds };
	});
	if (!cast) return undefined;
	const { agents, count, rounds } = cast;
	const members: MemberSpec[] = agents.map((agent) => ({ agent, count }));
	const size = agents.length * count;

	// Warned rather than refused: a swarm whose members cannot talk is a fan-out,
	// which is the control arm every run of this wants to be compared against.
	for (const agent of agents.filter((one) => !declaresBoard(one.tools))) {
		ctx.ui.notify(`swarm: ${agent.name} does not name \`board\` in its tools:, so it cannot reach the others - with nobody on the board, this runs as a fan-out`, "warning");
	}

	// The only value there is, named in the refusal: a `--until` nobody
	// recognises would otherwise run on the round cap and look like it worked.
	if (flags.until !== undefined && flags.until.trim().toLowerCase() !== "agree") {
		return refuse(ctx, `swarm: --until takes "agree", not "${flags.until}"`, "warning");
	}
	const toAgree = flags.until !== undefined;

	const keys = keysFrom(flags.claim);
	const claims = claimsFrom(keys, whole(flags.hold));
	const name = stepName(agents);
	const begun = beginStep(name, deps.runDir);

	let done: SwarmResult;
	try {
		done = await watched(ctx, deps, {
			status: agents.length > 1 ? `${agents.map((agent) => agent.name).join(", ")}…` : `${count} × ${name}…`,
			dir: begun.dir,
			work: (live) =>
				deps.swarm({
					members,
					// The vote is asked for here rather than in a definition: it is what
					// this run is finished by, and an agent that asked for one every time
					// would have every other run posting a vote nobody counts.
					goal: toAgree ? `${goal}\n\n${VOTE_INSTRUCTION}` : goal,
					...(rounds === undefined ? {} : { rounds }),
					...(claims ? { claims } : {}),
					// Agreement wins over coverage when both are asked for: the claims of a
					// debate hand out the opening positions, and reporting on one is not
					// the same as the others coming round to it.
					...(toAgree ? { until: agreed(size) } : keys.length ? { until: everythingDescribed(keys) } : {}),
					// A vote posted again in the same turn is not an argument, and the
					// members reading it next round count it as one.
					...(toAgree ? { resultsPerTurn: 1 } : {}),
					cwd: ctx.cwd,
					timeoutMs,
					exportDir: begun.dir,
					model: flags.model,
					signal: live.signal,
					spawn: live.spawn,
					onEvent: live.onEvent,
				}),
		});
	} catch (cause) {
		// A swarm refuses a configuration that cannot work - one round with
		// members that forget - and that refusal is the user's to read.
		return refuse(ctx, `swarm: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
	}

	// A member that failed still said something, and the ones beside it did the
	// work: a swarm is reported with its failed branches rather than dropped.
	if (done.members.every((one) => !one.result.ok)) {
		refuse(ctx, `swarm: every member failed - ${done.error ?? "no reason given"} - what ran is in ${shown(ctx, begun.dir)}`, "error");
		return undefined;
	}

	const step = finishStep(begun, { name, kind: "swarm", instruction: goal, output: swarmAnswer(done), usage: done.usage }, injected.appendEntry);
	ctx.ui.notify(swarmLine(step.id, done, shown(ctx, step.dir)), done.ok ? "info" : "warning");
	return step;
}

/** What the members produced, and what they said to each other while doing it. */
export function swarmAnswer(done: SwarmResult): string {
	const parts = [membersOutput(done.members)];
	// The board only when there is one: in a run where nobody posted, a heading
	// over nothing reads as something lost.
	if (done.posts.length > 0) parts.push(`## the board\n\n${boardLines(done.posts)}`);
	return parts.join("\n\n");
}

/** One line on what happened: how it ended, what is worth knowing about it, and the folder it went to. */
export function swarmLine(id: string, done: SwarmResult, folder: string): string {
	const failed = done.members.filter((one) => !one.result.ok).length;
	const held = done.claims.filter((one) => one.released).length;
	return [
		`${id}: ${plural(done.members.length, "member")}, ${plural(done.rounds, "round")}, ${plural(done.usage.turns, "turn")}, in ${folder}`,
		done.converged ? "converged" : `stopped by ${done.stoppedBy}`,
		done.posts.length ? plural(done.posts.length, "post") : "nothing posted",
		...(failed ? [`${failed} failed`] : []),
		// Only worth a word when it happened: these are the keys a member was
		// still holding when it stopped, which the swarm gave back for it.
		...(held ? [`${plural(held, "claim")} released for a member that had stopped`] : []),
		"/quote puts it in this conversation",
	].join(" - ");
}

/** What `--claim` named, in order, with the empty pieces of a trailing comma dropped. */
export function keysFrom(named: string | undefined): string[] {
	return (named ?? "").split(",").map((one) => one.trim()).filter(Boolean);
}

/**
 * Done when every named thing has been reported on, whoever did it.
 *
 * Without this a swarm spends every round it was given: measured in a real pi,
 * three members with three keys and three rounds posted six results, the last
 * three of them describing files that were already described. A round cap is a
 * bound on the worst case, not a plan.
 *
 * Reported on, not claimed: a key somebody took and never spoke about is not
 * done, and one described by a member that never held it is.
 */
export function everythingDescribed(keys: readonly string[]): (board: Board) => boolean {
	return (board) => {
		const results = board.all().filter((post) => post.kind === "result");
		return keys.every((key) => results.some((post) => post.text.includes(key)));
	};
}

/**
 * The leases, when the caller asked for any.
 *
 * Named keys are the strong form: a key that is not on the list is refused with
 * the list, so two spellings of one thing cannot both be granted. `--hold`
 * alone still bounds how much one member may take, on keys taken as written.
 */
export function claimsFrom(keys: readonly string[], hold: number | undefined): Claims | undefined {
	if (keys.length === 0 && hold === undefined) return undefined;
	return createClaims({
		...(keys.length ? { keys: [...keys] } : {}),
		...(hold === undefined ? {} : { maxPerMember: hold }),
	});
}

/**
 * What the step is called in the chain: the agent's name when copies of one
 * stand on the board, `swarm` when several do, since no one of them is the
 * step and `/step --from` wants a word somebody can type.
 */
export function stepName(agents: readonly Agent[]): string {
	return agents.length === 1 && agents[0] ? agents[0].name : "swarm";
}

/** A count the parser already checked, or `undefined` when it was not written. */
function whole(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number(value);
}
