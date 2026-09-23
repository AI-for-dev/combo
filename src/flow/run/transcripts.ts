/**
 * Where a run's subagents leave their transcripts, in its run directory.
 *
 * A subagent's home is its memory scope's path when it has one, its visit's
 * otherwise, and its files are `<home>/<agent>.jsonl` and `.html`: one pi
 * session is one replayable file, however many visits it served. A name
 * already taken, by an earlier life or by the subagent a timeout replaced,
 * takes the first free `~n`. A subagent's delegated children go in
 * `<its files>.children/`, named after their ids, and theirs under them.
 */

import { join } from "node:path";
import type { Agent } from "../../agent.ts";
import { exportBaseName, freeName } from "../../measure/index.ts";
import type { Subagent, SpawnOptions } from "../../subagent.ts";
import type { SpawnFn } from "../../workflows/options.ts";

/** Where the session files behind the transcripts live, out of the way of what a person opens. */
const SESSIONS = ".sessions";

/** The transcripts of one life of a run. */
export class Transcripts {
	private readonly runDir: string;
	/** Each subagent's files, without the extension, by id: where its children go. */
	private readonly files = new Map<string, string>();
	/** The names handed out in this life, whose files are not written until their subagent closes. */
	private readonly taken = new Set<string>();

	constructor(runDir: string) {
		this.runDir = runDir;
	}

	/** Spawns `agent` with `options` through `spawn`, exporting into `home`, a path in the run directory. */
	async atHome(spawn: SpawnFn, agent: Agent, options: SpawnOptions, home: string): Promise<Subagent> {
		const dir = join(this.runDir, home);
		const name = freeName(dir, agent.name, [".jsonl", ".html"], this.taken);
		this.taken.add(join(dir, name));
		return this.spawned(await spawn(agent, { ...options, exportDir: dir, exportName: name, sessionDir: join(this.runDir, SESSIONS) }), dir, name);
	}

	/** `spawn`, placing each child beside its parent's files, the one its options name as `parentId`. */
	children(spawn: SpawnFn): SpawnFn {
		return async (agent, options) => {
			// `delegateTool` names the parent of every child, and the parent was spawned here.
			const parent = this.files.get(options.parentId as string);
			if (parent === undefined) throw new Error(`No transcript for \`${options.parentId}\`, the parent of a delegated \`${agent.name}\``);
			const dir = `${parent}.children`;
			const subagent = await spawn(agent, { ...options, exportDir: dir, sessionDir: join(this.runDir, SESSIONS) });
			return this.spawned(subagent, dir, exportBaseName(subagent.id));
		};
	}

	private spawned(subagent: Subagent, dir: string, name: string): Subagent {
		this.files.set(subagent.id, join(dir, name));
		return subagent;
	}
}
