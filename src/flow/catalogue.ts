/**
 * What a flow is checked against, and where it is found on disk.
 *
 * Flows and agents are looked for where every definition is: the package's
 * own, the user's `~/.pi/agent/`, the repository's `.pi/`, least specific
 * first, and whoever is closer to the work wins the name.
 *
 * Unlike `loadAgents`, the agents' side keeps the files that are not agents,
 * with their cause. A flow names its agents and is checked before it runs, so
 * a name matching a broken file is reported as that file being broken, never
 * as unknown. And a broken file wins its name like any other: a repository's
 * `scout.md` that stopped parsing is not quietly replaced by the user's.
 *
 * The `pipelines/` directories the linear format was kept in are read too,
 * and only to be refused: see {@link removedPipelines}.
 */

import * as path from "node:path";
import { AGENTS_DIR, readAgentFile, type Agent, type AgentScope, type AgentSource, type BrokenAgent } from "../agent.ts";
import { BUILTIN_AGENTS_DIR, BUILTIN_FLOWS_DIR } from "../builtin.ts";
import { definitionDirs, readMarkdownDir, type MarkdownFile } from "../markdown.ts";
import type { Fault } from "./fault.ts";

/** Directory name under `~/.pi/agent/`, under `.pi/` and in the package. */
const FLOWS_DIR = "flows";

/** Where the linear pipelines were kept, beside `flows/`. */
const PIPELINES_DIR = "pipelines";

/** The guide page that rewrites a linear pipeline as a flow, which a `pipeline-format-removed` fault links to. */
export const MIGRATION_PAGE = "https://ai-for-dev.github.io/combo/guide/from-pipelines.html";

/** A flow file, and whose it is: the package's, the user's or the repository's. */
export type FoundFlow = MarkdownFile & {
	/** The directory it was read from: the package's, the user's or the repository's. */
	readonly source: AgentSource;
};

/** What a flow is checked against: the flow files by name, and the agents. */
export type FlowCatalogue = {
	/** Flow files, found by their file name without `.md`, which is the flow's name. */
	readonly flows: readonly FoundFlow[];
	/** The agents that parsed, one per name, the nearest winning it. */
	readonly agents: readonly Agent[];
	/** Agent files that are not agents, each under the name it would be asked for. */
	readonly brokenAgents: readonly BrokenAgent[];
	/** The directory the catalogue was loaded for: an agent's skills are looked up from it. */
	readonly cwd: string;
};

/**
 * The flows and agents of `cwd`, read from disk on every call, so editing a
 * file is enough.
 *
 * The scope defaults to `"user"` and `builtin` is off, as for `loadAgents`: a
 * repository's flows and agents are third-party instructions.
 */
export function loadFlowCatalogue(options: { cwd?: string; scope?: AgentScope; builtin?: boolean } = {}): FlowCatalogue {
	const cwd = options.cwd ?? process.cwd();
	const flows = nearest(definitionDirs(FLOWS_DIR, BUILTIN_FLOWS_DIR, options).flatMap(({ dir, source }) => readMarkdownDir(dir).map((file) => ({ ...file, source }))));
	const read = definitionDirs(AGENTS_DIR, BUILTIN_AGENTS_DIR, options).flatMap(({ dir, source }) => readMarkdownDir(dir).map((file) => readAgentFile(file, source)));
	const agents = nearest(read);
	return {
		flows,
		agents: agents.filter((agent): agent is Agent => !("error" in agent)),
		brokenAgents: agents.filter((agent): agent is BrokenAgent => "error" in agent),
		cwd,
	};
}

/** One definition per name, the last read winning it: definitions come least specific first. */
function nearest<T extends { readonly name: string }>(definitions: readonly T[]): T[] {
	return [...new Map(definitions.map((definition) => [definition.name, definition])).values()];
}

/** A file left in an old `pipelines/` directory: its name, whose it is, and why nothing reads it. */
export type RemovedPipeline = {
	/** Its file name without `.md`, the flow's name it would have had. */
	readonly name: string;
	/** Whose directory it is in: the user's or the repository's. */
	readonly source: AgentSource;
	/** Its `pipeline-format-removed` fault. */
	readonly fault: Fault;
};

/**
 * Every file in the user's or the repository's `pipelines/`, each refused
 * with `pipeline-format-removed`, on the same scope as
 * {@link loadFlowCatalogue}.
 *
 * Nothing is loaded from them. They are read so that a `build.md` of your own
 * left in `.pi/pipelines/` is named, rather than shadowed in silence by the
 * shipped `build` flow. The package ships no `pipelines/` of its own.
 */
export function removedPipelines(options: { cwd?: string; scope?: AgentScope } = {}): RemovedPipeline[] {
	return definitionDirs(PIPELINES_DIR, undefined, options).flatMap(({ dir, source }) => {
		const flows = path.join(path.dirname(dir), FLOWS_DIR);
		return readMarkdownDir(dir).map(({ name, filePath }) => ({
			name,
			source,
			fault: { code: "pipeline-format-removed", file: filePath, at: "", message: `a linear pipeline, which flows replace: rewrite it as a flow in ${flows}/ (${MIGRATION_PAGE})` },
		}));
	});
}
