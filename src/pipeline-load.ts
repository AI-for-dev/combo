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

import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentScope } from "./agent.ts";
import { BUILTIN_PIPELINES_DIR } from "./builtin.ts";
import { findProjectDir, readMarkdownDir } from "./markdown.ts";
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
 * explicit request.
 *
 * Precedence runs from the least specific to the most - shipped, then the
 * user's, then the repository's - so writing your own `build.md` replaces ours
 * without having to remove anything.
 */
export function loadPipelines(options: { cwd?: string; scope?: AgentScope; builtin?: boolean } = {}): PipelineCatalogue {
	const cwd = options.cwd ?? process.cwd();
	const scope = options.scope ?? "user";

	const byName = new Map<string, Pipeline>();
	const broken: BrokenPipeline[] = [];

	const take = (found: PipelineCatalogue) => {
		for (const pipeline of found.pipelines) byName.set(pipeline.name, pipeline);
		broken.push(...found.broken);
	};

	// Least specific first, so a `build.md` of your own replaces the one shipped
	// here rather than competing with it. Off by default, like the agents.
	if (options.builtin) take(loadPipelinesFromDir(BUILTIN_PIPELINES_DIR));
	if (scope !== "project") take(loadPipelinesFromDir(path.join(getAgentDir(), PIPELINES_DIR)));
	if (scope !== "user") {
		const projectDir = findProjectDir(cwd, PIPELINES_DIR);
		if (projectDir) take(loadPipelinesFromDir(projectDir));
	}

	return { pipelines: [...byName.values()], broken };
}

/** Reads every `.md` in a directory. A missing or unreadable directory yields nothing. */
export function loadPipelinesFromDir(dir: string): PipelineCatalogue {
	const pipelines: Pipeline[] = [];
	const broken: BrokenPipeline[] = [];

	for (const file of readMarkdownDir(dir)) {
		try {
			pipelines.push(parsePipeline(file.content, file.filePath));
		} catch (cause) {
			// Collected, not dropped: a pipeline you are looking at and cannot
			// run has to say why. This is where agents and pipelines differ.
			broken.push({ filePath: file.filePath, name: file.name, error: (cause as Error).message });
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
