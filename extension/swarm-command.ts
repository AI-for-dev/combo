/**
 * `/swarm`: several copies of one agent on one job, from inside pi.
 *
 * Every other command here decides who does what - `/run` walks a pipeline,
 * `/step` names the agent itself, `/build` has a planner write the split. A
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

import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	boardLines,
	checkModel,
	createClaims,
	createRunDir,
	declaresBoard,
	exportBaseName,
	findAgent,
	plural,
	swarm,
	type Agent,
	type Board,
	type Claims,
	type SwarmResult,
} from "../src/index.ts";
import { loadRoster, parseLeadingFlags, refuse, type CommandCtx } from "./command.ts";
import { currentChain, recordStep, startChain, type RelayStep } from "./relay.ts";
import { liveRun, STATUS } from "./run-ui.ts";
import { STEP_ENTRY, type StepDeps } from "./step-commands.ts";

/** The agent a swarm is made of when the command is not told otherwise. */
export const DEFAULT_MEMBER = "member";

/** How many copies stand on the board when the command is not told otherwise. */
export const DEFAULT_MEMBERS = 3;

/** Registers `/swarm`. */
export default function registerSwarmCommand(pi: ExtensionAPI) {
	const deps: StepDeps = {
		sendMessage: (message) => pi.sendMessage(message),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	};

	pi.registerCommand("swarm", {
		description:
			"Put several copies of one agent on one job, with a board between them (`--members <n>`, `--claim a,b`, `--hold <n>`, `--rounds <n>`, `--agent <name>`, `--model <pattern>`)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runSwarm(args, ctx as unknown as CommandCtx, deps);
		},
	});
}

/**
 * `/swarm [--members <n>] [--claim a,b,c] [--hold <n>] [--rounds <n>] [--agent <name>] [--model <pattern>] <goal>`.
 *
 * `--claim` is what turns announcing into holding: named, the things are leased
 * one owner at a time and a second member is refused and told who has it.
 * Without it the members are on their honour, which a run showed is a race
 * whatever the prompt says.
 */
export async function runSwarm(args: string, ctx: CommandCtx, deps: StepDeps = {}): Promise<RelayStep | undefined> {
	const { flags, rest: goal } = parseLeadingFlags(args, ["members", "rounds", "hold", "claim", "agent", "model"]);
	if (!goal.trim()) {
		return refuse(ctx, "swarm: say what they are all on, for example /swarm describe every file under src/reporters/", "warning");
	}

	const agents = loadRoster(ctx, deps);
	let member: Agent;
	let count: number;
	let rounds: number | undefined;
	try {
		member = findAgent(agents, flags.agent ?? DEFAULT_MEMBER);
		count = whole(flags.members, "members") ?? DEFAULT_MEMBERS;
		rounds = whole(flags.rounds, "rounds");
		if (flags.model) await (deps.checkModel ?? checkModel)(flags.model);
	} catch (cause) {
		return refuse(ctx, cause instanceof Error ? cause.message : String(cause), "error");
	}

	// Warned rather than refused: a swarm whose members cannot talk is a fan-out,
	// which is the control arm every run of this wants to be compared against.
	if (!declaresBoard(member.tools)) {
		ctx.ui.notify(`swarm: ${member.name} does not name \`board\` in its tools:, so its copies cannot reach one another - this runs as a fan-out`, "warning");
	}

	// `--claim a.ts, b.ts` reads as one key and two words of goal, because a flag
	// value stops at the first space everywhere in pi. Silently running on the
	// wrong list is the worst of the three ways out, so the comma is caught.
	if (flags.claim?.endsWith(",")) {
		return refuse(ctx, "swarm: --claim takes one comma-separated list with no spaces, for example --claim a.ts,b.ts", "warning");
	}

	const keys = keysFrom(flags.claim);
	const claims = claimsFrom(keys, whole(flags.hold, "hold"));
	const relay = currentChain() ?? startChain((deps.runDir ?? createRunDir)());
	const dir = path.join(relay.dir, `${relay.steps.length + 1}-${exportBaseName(member.name)}`);
	const live = liveRun(ctx.ui, { tickMs: deps.tickMs, signal: ctx.signal });
	ctx.ui.setStatus(STATUS, `${count} × ${member.name}…`);

	let done: SwarmResult | undefined;
	try {
		done = await (deps.swarm ?? swarm)({
			members: [{ agent: member, count }],
			goal,
			...(rounds === undefined ? {} : { rounds }),
			...(claims ? { claims } : {}),
			...(keys.length ? { until: everythingDescribed(keys) } : {}),
			cwd: ctx.cwd,
			exportDir: dir,
			model: flags.model,
			signal: live.signal,
			spawn: live.spawn,
			onEvent: live.onEvent,
		});
	} catch (cause) {
		return refuse(ctx, `swarm: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
	} finally {
		live.stop(dir, done?.usage.wallMs ?? 0);
	}

	// A member that failed still said something, and the ones beside it did the
	// work: a swarm is reported with its failed branches rather than dropped.
	if (done.members.every((one) => !one.result.ok)) {
		refuse(ctx, `swarm: every member failed - ${done.error ?? "no reason given"} - what ran is in ${dir}`, "error");
		return undefined;
	}

	const step = recordStep(relay, {
		name: member.name,
		kind: "swarm",
		instruction: goal,
		output: swarmAnswer(done),
		usage: done.usage,
		dir,
	});
	deps.appendEntry?.(STEP_ENTRY, { id: step.id, kind: step.kind, output: step.output, turns: done.usage.turns, dir });
	ctx.ui.notify(swarmLine(step.id, done), done.ok ? "info" : "warning");
	return step;
}

/** What the members produced, and what they said to each other while doing it. */
export function swarmAnswer(done: SwarmResult): string {
	const parts = done.members.map((one) => {
		const said = one.result.output.trim() || one.result.error || "(nothing)";
		return `## ${one.id}${one.result.ok ? "" : " - failed"}\n\n${said}`;
	});
	// The board only when there is one: in a run where nobody posted, a heading
	// over nothing reads as something lost.
	if (done.posts.length > 0) parts.push(`## the board\n\n${boardLines(done.posts)}`);
	return parts.join("\n\n");
}

/** One line on what happened: how it ended, and what is worth knowing about it. */
export function swarmLine(id: string, done: SwarmResult): string {
	const failed = done.members.filter((one) => !one.result.ok).length;
	const held = done.claims.filter((one) => one.released).length;
	return [
		`${id}: ${plural(done.members.length, "member")}, ${plural(done.rounds, "round")}, ${plural(done.usage.turns, "turn")}`,
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

/** A whole number a user typed, or a refusal naming the flag they got wrong. */
function whole(value: string | undefined, flag: string): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) throw new Error(`swarm: --${flag} takes a whole number of at least 1, not "${value}"`);
	return n;
}
