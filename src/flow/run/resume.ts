/**
 * `resumeFlow`: a run carried on from its run directory, as deep as its
 * journal goes.
 *
 * It runs what the snapshot holds, never the flow files on disk, checked
 * again at both stages with the scripts the run started with, on the input
 * and the settings it started with. Only `timeoutMs` may be given again. The
 * subagents are fresh, since no conversation is kept: each reads its
 * `reads:`, its ledger and the tree. The same journal goes on, under the same
 * lock, and the run's branch must be where `HEAD` is: a resume checks it, and
 * never switches to it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkFlow } from "../check.ts";
import { checkRun, type FlowPorts } from "../check-run.ts";
import type { Fault } from "../fault.ts";
import { realWorld, walkFlow, type FlowResult, type RunFlowOptions } from "./flow.ts";
import { readJournal } from "./journal.ts";
import { whileLocked } from "./lock.ts";
import { resumePoint } from "./resume-point.ts";
import { readSnapshot, SNAPSHOT_FILE, type Snapshot } from "./snapshot.ts";

/**
 * What a resume is given: where it runs, and the switches of a run. `model`
 * and `input` are the run's own, frozen: giving either refuses the resume.
 */
export type ResumeFlowOptions = Pick<RunFlowOptions, "spawn" | "signal" | "onEvent" | "timeoutMs" | "model"> & {
	/** How the resumed run reaches the world, checked again at the run stage. */
	readonly ports: FlowPorts;
	/** Whether a person can answer now: the run stage holds the flow to it, as at a start. */
	readonly somebodyThere: boolean;
	/** Refused when given: the input is the run's own, kept in its snapshot. */
	readonly input?: unknown;
};

/**
 * How a resume ended: as the run did, with the visit it picked up from and a
 * line saying which flow files changed on disk since it started; or refused
 * before anything ran, with why, or with the faults of a check.
 */
export type Resumed =
	| (FlowResult & { readonly from: string; readonly changed?: string })
	| { readonly ok: false; readonly refused: string }
	| { readonly ok: false; readonly faults: readonly Fault[] };

/** Resumes the run in `runDir`. Throws when the directory holds no snapshot: it holds no run. */
export async function resumeFlow(runDir: string, options: ResumeFlowOptions): Promise<Resumed> {
	const frozen = (["model", "input"] as const).filter((key) => options[key] !== undefined);
	if (frozen.length > 0) return { ok: false, refused: `a resume runs with the settings its run started with, so \`${frozen.join("`, `")}\` cannot be given again: a new run is how to change them` };
	const snapshot = readSnapshot(runDir);
	return whileLocked(runDir, (refused): Resumed => ({ ok: false, refused }), () => resumeLocked(runDir, snapshot, options));
}

async function resumeLocked(runDir: string, snapshot: Snapshot, options: ResumeFlowOptions): Promise<Resumed> {
	const { settings } = snapshot;
	const checked = checkFlow(snapshot.flow, snapshot.catalogue);
	if (!checked.ok) return { ok: false, faults: checked.faults };
	const staged = await checkRun(checked.flow, { cwd: settings.cwd, ports: options.ports, somebodyThere: options.somebodyThere }, snapshot.scripts);
	if (!staged.ok) return { ok: false, faults: staged.faults };
	const point = resumePoint(checked.flow, readJournal(runDir));
	if (!point.ok) return point;
	const { replay } = point;
	if (replay.branch !== undefined) {
		const refused = await offBranch(options.ports, settings.cwd, replay.branch);
		if (refused !== undefined) return { ok: false, refused };
	}
	// Read before the walk, whose agents may write to the very files compared.
	const changed = changedOnDisk(snapshot);
	const { spawn, signal, onEvent } = options;
	const world = realWorld(staged.run, snapshot.input, runDir, replay);
	const result = await walkFlow(checked.flow, snapshot.input, { spawn, signal, onEvent, model: settings.model, timeoutMs: options.timeoutMs ?? settings.timeoutMs }, world, settings.cwd);
	return { ...result, from: point.from, ...(changed !== undefined && { changed }) };
}

/** Why `HEAD` in `cwd` is not on the run's `branch`, when it is not. */
async function offBranch(ports: FlowPorts, cwd: string, branch: string): Promise<string | undefined> {
	// The run opened a branch, so its flow commits, and the run stage required the `git` port.
	const git = ports.git as NonNullable<FlowPorts["git"]>;
	if ((await git.currentBranch(cwd)) === branch) return undefined;
	if (!(await git.hasBranch(cwd, branch))) return `the run's branch \`${branch}\` is gone: a new run is how to start again`;
	return `\`HEAD\` is not on the run's branch: \`git switch ${branch}\`, then resume`;
}

/** One line naming the flow files of `snapshot` that differ on disk now, when any does. */
function changedOnDisk({ catalogue, settings }: Snapshot): string | undefined {
	const changed = catalogue.flows.filter(({ filePath, content }) => {
		try {
			return readFileSync(resolve(settings.cwd, filePath), "utf-8") !== content;
		} catch {
			return true;
		}
	});
	if (changed.length === 0) return undefined;
	const names = changed.map(({ filePath }) => `\`${relative(settings.cwd, resolve(settings.cwd, filePath))}\``).join(", ");
	return `${names} changed since the run started; resuming the version it started with`;
}

/** The run a resume would take, and the visit it picks up from; or the newest run, and why it cannot. */
export type Resumable = { readonly ok: true; readonly runDir: string; readonly from: string } | { readonly ok: false; readonly runDir: string; readonly refused: string };

/**
 * The newest run under `runsDir` started in `cwd` that a resume would take,
 * newest by directory name, which a run directory's timestamp makes its age.
 * When none would, the newest run of `cwd` and why; nothing when `cwd`
 * started none there. A directory holding no snapshot holds no run, and one
 * that no longer reads or checks cannot be resumed by this version anyway.
 */
export function latestResumable(runsDir: string, cwd: string): Resumable | undefined {
	let newest: Resumable | undefined;
	for (const name of existsSync(runsDir) ? readdirSync(runsDir).sort().reverse() : []) {
		const runDir = join(runsDir, name);
		if (!existsSync(join(runDir, SNAPSHOT_FILE))) continue;
		let snapshot: Snapshot;
		try {
			snapshot = readSnapshot(runDir);
		} catch {
			continue;
		}
		if (resolve(snapshot.settings.cwd) !== resolve(cwd)) continue;
		const checked = checkFlow(snapshot.flow, snapshot.catalogue);
		if (!checked.ok) continue;
		const point = resumePoint(checked.flow, readJournal(runDir));
		if (point.ok) return { ok: true, runDir, from: point.from };
		newest ??= { ok: false, runDir, refused: point.refused };
	}
	return newest;
}
