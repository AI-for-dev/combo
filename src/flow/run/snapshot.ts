/**
 * The snapshot of a run: what its validation read, kept in its run directory
 * at the first start with the input and the settings, so that a resume runs
 * the flow the run started with, whatever the disk says by then.
 *
 * `snapshot.json` holds every flow file reached, each agent named, each check
 * script's content, the input and the settings. The skills an agent names
 * are copied under `agents/<agent>/skills/`, where a definition keeps its
 * own: read back, the agent lives there, so its skills resolve to the copies
 * at the check and at the spawn alike.
 */

import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Agent } from "../../agent.ts";
import type { MarkdownFile } from "../../markdown.ts";
import type { Skill } from "../../skills.ts";
import type { FlowCatalogue } from "../catalogue.ts";
import type { CheckedRun } from "../check-run.ts";

/** Where the snapshot is, in a run directory. */
export const SNAPSHOT_FILE = "snapshot.json";

/** Bumped when what `snapshot.json` holds changes shape: a snapshot of another is not read. */
const VERSION = 1;

/** What a run was started with, beside its flow: frozen, so a resume is the same run. */
export type Settings = {
	/** The working tree it was checked against. */
	readonly cwd: string;
	readonly somebodyThere: boolean;
	readonly model?: string;
	readonly timeoutMs?: number;
};

/** A snapshot read back: the flow's name, a catalogue holding exactly what its check read, and what the run was started with. */
export type Snapshot = {
	readonly flow: string;
	readonly catalogue: FlowCatalogue;
	/** Each check script's content, by its path. */
	readonly scripts: ReadonlyMap<string, string>;
	readonly input: unknown;
	readonly settings: Settings;
};

/** `snapshot.json`, as written. */
type Written = {
	readonly version: number;
	readonly flow: string;
	readonly flows: readonly MarkdownFile[];
	readonly agents: readonly Agent[];
	readonly scripts: Readonly<Record<string, string>>;
	readonly input: unknown;
	readonly settings: Settings;
};

/**
 * Writes the snapshot of `run`, started on `input` with `given`, into
 * `runDir`, made when missing. Throws on a directory already holding one:
 * a run directory is one run's.
 */
export function writeSnapshot(runDir: string, run: CheckedRun, input: unknown, given: Pick<Settings, "model" | "timeoutMs">): void {
	mkdirSync(runDir, { recursive: true });
	const { flows, agents } = run.flow.sources;
	const written: Written = {
		version: VERSION,
		flow: run.flow.name,
		flows,
		agents: agents.map(({ agent }) => agent),
		scripts: Object.fromEntries(run.scripts),
		input,
		settings: { cwd: run.cwd, somebodyThere: run.somebodyThere, ...given },
	};
	writeFileSync(join(runDir, SNAPSHOT_FILE), `${JSON.stringify(written, null, "\t")}\n`, { flag: "wx" });
	for (const { agent, skills } of agents) {
		for (const skill of skills) copySkill(skill, join(skillsDir(runDir, agent.name), skill.name));
	}
}

/** The snapshot in `runDir`. Throws when there is none, or one of another version. */
export function readSnapshot(runDir: string): Snapshot {
	const written = JSON.parse(readFileSync(join(runDir, SNAPSHOT_FILE), "utf-8")) as Written;
	if (written.version !== VERSION) throw new Error(`${join(runDir, SNAPSHOT_FILE)} is a snapshot of version ${written.version}, and this reads version ${VERSION}`);
	const { flow, flows, scripts, input, settings } = written;
	const agents = written.agents.map((agent) => ({ ...agent, filePath: join(runDir, "agents", `${agent.name}.md`) }));
	return { flow, catalogue: { flows, agents, brokenAgents: [], cwd: settings.cwd }, scripts: new Map(Object.entries(scripts)), input, settings };
}

/** Where the agent `name` of a snapshot keeps its skills: beside its definition, as `skillDirs` looks first. */
function skillsDir(runDir: string, name: string): string {
	return join(runDir, "agents", name, "skills");
}

/**
 * Copies `skill` to `to`: its whole directory when it is a `SKILL.md`, since
 * the model may open what sits beside it, or its one file as `SKILL.md`.
 */
function copySkill(skill: Skill, to: string): void {
	if (basename(skill.filePath) === "SKILL.md") {
		cpSync(skill.baseDir, to, { recursive: true, dereference: true });
		return;
	}
	mkdirSync(to, { recursive: true });
	copyFileSync(skill.filePath, join(to, "SKILL.md"));
}
