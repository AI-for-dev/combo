/**
 * Definitions on disk: how a `.md` with frontmatter is found and read.
 *
 * Agents, pipelines and flows are the same file format, discovered the same
 * way - a directory of `.md` files, and a walk up the parents to the first
 * `.pi/<something>/`. Only what happens to a file *after* it is read differs,
 * and that difference is the point: `loadAgents` drops an agent that does not
 * parse in silence, a pipeline or a flow's catalogue collects it and reports it
 * by name. So this file finds and reads; it never decides what a file means.
 *
 * The frontmatter coercions live here too, because "YAML-ish" is a property of
 * the format rather than of either reader: a flag written `true` in a file
 * arrives as the string `"true"` about as often as a boolean.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentScope, AgentSource } from "./agent.ts";

/** One Markdown file, read. */
export type MarkdownFile = {
	/** Its full path - what an error message has to name. */
	filePath: string;
	/** The file name without `.md`: the fallback name of a definition that fails to parse. */
	name: string;
	/** Its whole content, frontmatter included. */
	content: string;
};

/**
 * Every readable `.md` in `dir`, by name.
 *
 * A missing or unreadable directory yields `[]`, and so does an unreadable
 * file: discovery scans places that legitimately do not exist - a repository
 * with no `.pi/`, a user who never made one - and a missing directory is not an
 * error to report, it is the normal case.
 *
 * Sorted, so two runs on the same directory load the same definitions in the
 * same order whatever the filesystem feels like returning.
 */
export function readMarkdownDir(dir: string): MarkdownFile[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: MarkdownFile[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md")) continue;
		// Symlinks count: this repository's own definitions are symlinked into `.pi/`.
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		try {
			files.push({ filePath, name: entry.name.replace(/\.md$/, ""), content: fs.readFileSync(filePath, "utf-8") });
		} catch {
			// unreadable: not ours to complain about
		}
	}
	return files;
}

/** A directory definitions are read from, and whose they are. */
export type DefinitionDir = { dir: string; source: AgentSource };

/**
 * Where the definitions kept under `<sub>/` are looked for, **least specific
 * first**: the package's own (`builtinDir`) when `builtin` is set, then the
 * user's `~/.pi/agent/<sub>/`, then the repository's nearest `.pi/<sub>/`.
 *
 * A caller reads them in this order into one map by name, so whoever is closer
 * to the work wins it. The scope defaults to `"user"`: a repository's
 * definitions are third-party instructions, loaded only on explicit request.
 */
export function definitionDirs(sub: string, builtinDir: string, options: { cwd?: string; scope?: AgentScope; builtin?: boolean }): DefinitionDir[] {
	const scope = options.scope ?? "user";
	const dirs: DefinitionDir[] = [];
	if (options.builtin) dirs.push({ dir: builtinDir, source: "builtin" });
	if (scope !== "project") dirs.push({ dir: path.join(getAgentDir(), sub), source: "user" });
	const projectDir = scope === "user" ? undefined : findProjectDir(options.cwd ?? process.cwd(), sub);
	if (projectDir) dirs.push({ dir: projectDir, source: "project" });
	return dirs;
}

/** Walks up from `cwd` to the first `.pi/<sub>/` that exists. */
export function findProjectDir(cwd: string, sub: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, sub);
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

/**
 * A YAML error in a file's frontmatter, as one line: the reason, then the line
 * in the file. `yaml` counts from the first line of the frontmatter, which is
 * the file's second, after the opening `---`.
 */
export function yamlError(error: unknown): string {
	const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
	const reason = (error as Error).message.split(" at line")[0] ?? (error as Error).message;
	return line === undefined ? reason : `${reason}, line ${line + 1}`;
}

/** Frontmatter text, trimmed. Blank counts as absent: `name:` with nothing after it says nothing. */
export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * A YAML-ish count: a positive whole number, however the parser handed it over.
 *
 * Anything else is `undefined` rather than coerced. `concurrency: 0` and
 * `concurrency: two` are typos, and a field that turned the first into "no
 * branches at all" would be a setting nobody meant to write.
 */
export function asCount(value: unknown): number | undefined {
	const count = typeof value === "number" ? value : Number(asString(value));
	return Number.isInteger(count) && count > 0 ? count : undefined;
}

/**
 * A YAML-ish list: a real sequence, or one line of comma-separated items.
 *
 * Empty counts as absent, item by item: `tools: read, , grep` names two tools,
 * and `skills:` with nothing after it names none - which is what lets a caller
 * tell "the file said nothing" from "the file said nothing useful".
 */
export function asList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : asString(value)?.split(",");
	const items = (raw ?? []).map(asString).filter((item) => item !== undefined);
	return items.length > 0 ? items : undefined;
}

/** A YAML-ish flag: a boolean, or the text `"true"` / `"false"`. */
export function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}
