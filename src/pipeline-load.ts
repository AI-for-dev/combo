/**
 * Finding the pipelines a user wrote, wherever they put them.
 *
 * Same convention as agents, deliberately: `~/.pi/agent/pipelines/` for your
 * own, `.pi/pipelines/` for a repository's, one Markdown file each, rediscovered
 * on every call so editing a file is enough. Someone who has already learnt
 * where agents live should not have to learn a second layout.
 *
 * Where it differs from agents, and why: **a malformed pipeline is never
 * ignored.** An agent is *discovered*, so an incomplete file is dropped in
 * silence; a pipeline is *asked for by name*, so answering "unknown pipeline"
 * about a file sitting right there would be a lie. But one broken file must not
 * hide the nine that parse either - so loading collects the failures instead of
 * throwing, and {@link findPipeline} raises them when, and only when, the broken
 * file is the one being asked for.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentScope } from "./agent.ts";
import { parsePipeline, type Pipeline } from "./pipeline.ts";

/** Directory name under `~/.pi/agent/` and under `.pi/`. */
export const PIPELINES_DIR = "pipelines";

/** A file that looks like a pipeline and does not parse. Kept, never swallowed. */
export type BrokenPipeline = {
	/** Where the file is, so the message can be acted on. */
	filePath: string;
	/** The name it would have been asked for by: its file name without `.md`. */
	name: string;
	/** What `parsePipeline` refused, verbatim. */
	error: string;
};

/** What a directory scan found: what runs, and what cannot. */
export type PipelineCatalogue = {
	/** Every pipeline that parsed, in discovery order. */
	pipelines: Pipeline[];
	/** Every file that did not, so a typo is reported rather than hidden. */
	broken: BrokenPipeline[];
};

/**
 * Discovers the available pipelines.
 *
 * The scope defaults to `"user"` for the same reason it does for agents: a
 * pipeline carries prose that becomes an instruction to a model, so a
 * repository's pipelines are third-party instructions and are loaded only on
 * explicit request. With `"both"`, a project pipeline shadows a user one of the
 * same name.
 */
export function loadPipelines(options: { cwd?: string; scope?: AgentScope } = {}): PipelineCatalogue {
	const cwd = options.cwd ?? process.cwd();
	const scope = options.scope ?? "user";

	const byName = new Map<string, Pipeline>();
	const broken: BrokenPipeline[] = [];

	const take = (found: PipelineCatalogue) => {
		for (const pipeline of found.pipelines) byName.set(pipeline.name, pipeline);
		broken.push(...found.broken);
	};

	if (scope !== "project") take(loadPipelinesFromDir(path.join(getAgentDir(), PIPELINES_DIR)));
	if (scope !== "user") {
		const projectDir = findProjectPipelinesDir(cwd);
		if (projectDir) take(loadPipelinesFromDir(projectDir));
	}

	return { pipelines: [...byName.values()], broken };
}

/** Reads every `.md` in a directory. A missing or unreadable directory yields nothing. */
export function loadPipelinesFromDir(dir: string): PipelineCatalogue {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return { pipelines: [], broken: [] };
	}

	const pipelines: Pipeline[] = [];
	const broken: BrokenPipeline[] = [];

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			pipelines.push(parsePipeline(content, filePath));
		} catch (cause) {
			broken.push({ filePath, name: entry.name.replace(/\.md$/, ""), error: (cause as Error).message });
		}
	}

	return { pipelines, broken };
}

/**
 * Looks up a pipeline by name, or throws.
 *
 * A name that matches a **broken** file reports why it is broken, rather than
 * claiming it does not exist. Getting "unknown pipeline: build" for a
 * `build.md` you are looking at is the kind of message that costs an hour.
 */
export function findPipeline(catalogue: PipelineCatalogue, name: string): Pipeline {
	const pipeline = catalogue.pipelines.find((candidate) => candidate.name === name);
	if (pipeline) return pipeline;

	const broken = catalogue.broken.find((candidate) => candidate.name === name);
	if (broken) throw new Error(`Pipeline "${name}" (${broken.filePath}) does not parse: ${broken.error}`);

	if (catalogue.pipelines.length === 0) {
		throw new Error(
			`Unknown pipeline "${name}": none were loaded. Your own live in ${path.join(getAgentDir(), PIPELINES_DIR)}; ` +
				`a repository's in ${CONFIG_DIR_NAME}/${PIPELINES_DIR} are only loaded with scope "project" or "both".`,
		);
	}
	throw new Error(
		`Unknown pipeline "${name}". Loaded: ${catalogue.pipelines.map((candidate) => candidate.name).join(", ")}`,
	);
}

/** Walks up parent directories to the first `.pi/pipelines/`. */
function findProjectPipelinesDir(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, PIPELINES_DIR);
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// not here, walk up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
