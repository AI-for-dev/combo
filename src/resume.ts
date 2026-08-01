/**
 * Saving a build so it can be picked up again.
 *
 * A delivery is long, it costs money, and it writes to a working tree. Losing it
 * to a Ctrl+C, a dropped connection or a closed terminal means paying twice for
 * work that is already on disk - the files the workers wrote are still there.
 *
 * What is saved is deliberately **not** a snapshot of the objects: `Agent`s are
 * saved by name and resolved again on resume, and `Result.messages` are dropped
 * entirely. A resumed build re-reads the code, it does not replay a conversation
 * - which is also why the file stays small enough to write after every step.
 */

import fs from "node:fs";
import path from "node:path";
import type { Agent } from "./agent.ts";
import type { Result } from "./result.ts";
import { emptyUsage, type Usage } from "./usage.ts";
import type { AuditRound } from "./workflows/deliver.ts";
import type { PairResult } from "./workflows/pair.ts";
import type { PlannedTask } from "./workflows/plan.ts";
import type { Verification } from "./verify.ts";

/** The file a build writes into its run directory. */
export const BUILD_STATE_FILE = "build.json";

/** Bumped when the shape changes; an older file is ignored rather than guessed at. */
export const BUILD_STATE_VERSION = 1;

type SavedStep = { agent: string; task: string };

type SavedTask = SavedStep & {
	output: string;
	ok: boolean;
	error?: string;
	approved: boolean;
	rounds: number;
	usage: Usage;
};

type SavedAudit = {
	output: string;
	ok: boolean;
	approved: boolean;
	fixes: SavedStep[];
};

/** The build as it is written to `build.json`, and read back by `/build resume`. */
export type BuildState = {
	/** {@link BUILD_STATE_VERSION}. A state from another version is refused whole. */
	version: number;
	/** What the user typed, kept for the branch name and for a human reading it. */
	request: string;
	/** The specification the interview produced. It is not re-negotiated on resume. */
	brief: string;
	/**
	 * The pipeline step this progress belongs to.
	 *
	 * Optional, and deliberately so: a state written before pipelines existed
	 * has none, and a pipeline with a single delivery has nothing to
	 * disambiguate. It matters only when a pipeline delivers twice - handing the
	 * second one the first one's approved subtasks would resume the wrong work.
	 */
	step?: string;
	/** Where the work was done. Resuming elsewhere would resume onto another tree. */
	cwd: string;
	/** ISO 8601, first write. Kept across saves, so a build has one age. */
	startedAt: string;
	/** ISO 8601, last write. This is what tells a stale run from a live one. */
	updatedAt: string;
	/** The plan, by agent name. Reused on resume, never made again. */
	plan: SavedStep[];
	/** Finished subtasks, in plan order. Shorter than `plan` while it runs. */
	tasks: SavedTask[];
	/** The audit rounds already spent. Resuming continues the cycle, it does not restart it. */
	audits: SavedAudit[];
	/** The last verdict of the project's own check, when one was run. */
	verification?: Verification;
	/** True once the build reached its own end - approved or not. */
	done: boolean;
};

/** What `deliver` reports as it goes, and what it accepts to start again from. */
/** The same picture in memory: live results rather than names and text. */
export type BuildProgress = {
	/** The subtasks, with their agents resolved. */
	plan: PlannedTask[];
	/** Finished subtasks, in plan order. Only the approved ones survive a resume. */
	tasks: PairResult[];
	/** One entry per audit round, in order. */
	audits: AuditRound[];
	/** The check's verdict, when a `verify` port was given. It is final. */
	verification?: Verification;
	/** True once the build reached its own end - approved or not. */
	done: boolean;
};

/** Turns live results into something that survives the process. */
export function toBuildState(
	progress: BuildProgress,
	about: { request: string; brief: string; cwd: string; startedAt?: string; step?: string },
): BuildState {
	const now = new Date().toISOString();
	return {
		version: BUILD_STATE_VERSION,
		request: about.request,
		brief: about.brief,
		step: about.step,
		cwd: about.cwd,
		startedAt: about.startedAt ?? now,
		updatedAt: now,
		plan: progress.plan.map((step) => ({ agent: step.agent.name, task: step.task })),
		tasks: progress.tasks.map((task) => ({
			agent: task.agent,
			task: task.input,
			output: task.output,
			ok: task.ok,
			error: task.error,
			approved: task.approved,
			rounds: task.rounds,
			usage: task.usage,
		})),
		audits: progress.audits.map((round) => ({
			output: round.review.output,
			ok: round.review.ok,
			approved: round.approved,
			fixes: round.fixes.map((fix) => ({ agent: fix.agent.name, task: fix.task })),
		})),
		verification: progress.verification,
		done: progress.done,
	};
}

/**
 * Rebuilds what `deliver` needs to carry on.
 *
 * Agents are looked up by name: a state whose agents have been renamed or
 * deleted comes back with fewer steps rather than with a guess, and the missing
 * ones are simply re-planned. `undefined` for a plan step nobody can run means
 * the whole plan is refused - a half-plan would silently drop work.
 */
export function fromBuildState(state: BuildState, agents: readonly Agent[]): BuildProgress | undefined {
	if (state.version !== BUILD_STATE_VERSION) return undefined;

	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const plan: PlannedTask[] = [];
	for (const step of state.plan) {
		const agent = byName.get(step.agent);
		if (!agent) return undefined;
		plan.push({ agent, task: step.task });
	}

	const tasks: PairResult[] = state.tasks.map((task) => ({
		agent: task.agent,
		input: task.task,
		output: task.output,
		messages: [],
		usage: task.usage ?? emptyUsage(),
		ok: task.ok,
		error: task.error,
		steps: [],
		rounds: task.rounds,
		approved: task.approved,
	}));

	const audits: AuditRound[] = state.audits.map((round) => ({
		review: { agent: "auditor", output: round.output, messages: [], usage: emptyUsage(), ok: round.ok } as Result,
		approved: round.approved,
		fixes: round.fixes.flatMap((fix) => {
			const agent = byName.get(fix.agent);
			return agent ? [{ agent, task: fix.task }] : [];
		}),
		results: [],
	}));

	return { plan, tasks, audits, verification: state.verification, done: state.done };
}

/** Writes the state into a run directory. Never throws: it is a safety net. */
export function saveBuildState(dir: string, state: BuildState): string | undefined {
	try {
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, BUILD_STATE_FILE);
		fs.writeFileSync(file, `${JSON.stringify(state, null, "\t")}\n`);
		return file;
	} catch {
		// losing the ability to resume must never take the build down with it
		return undefined;
	}
}

/**
 * The plan's agents the roster no longer has, in the order they appear.
 *
 * {@link fromBuildState} refuses a state it cannot rebuild, and refusing without
 * saying which name is missing leaves the user nothing to act on. Empty means
 * every agent is there.
 */
export function missingAgents(state: BuildState, agents: readonly Agent[]): string[] {
	const known = new Set(agents.map((agent) => agent.name));
	return [...new Set(state.plan.map((step) => step.agent).filter((name) => !known.has(name)))];
}

/** Reads a state file. `undefined` when it is missing, unreadable or foreign. */
export function loadBuildState(file: string): BuildState | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as BuildState;
		return parsed?.version === BUILD_STATE_VERSION ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The most recent unfinished build for `cwd`, if there is one.
 *
 * Directories are sorted by name, which is a timestamp: no `stat` call, and the
 * ordering is the same one `ls` shows. A build that finished is skipped - "carry
 * on" means carrying on something that stopped short.
 */
export function findResumableBuild(base = "runs", cwd?: string): { dir: string; state: BuildState } | undefined {
	let entries: string[];
	try {
		entries = fs.readdirSync(base).sort().reverse();
	} catch {
		return undefined;
	}

	for (const entry of entries) {
		const dir = path.join(base, entry);
		const state = loadBuildState(path.join(dir, BUILD_STATE_FILE));
		if (!state || state.done) continue;
		if (cwd && path.resolve(state.cwd) !== path.resolve(cwd)) continue;
		return { dir, state };
	}
	return undefined;
}
