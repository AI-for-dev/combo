/**
 * Definitions on disk: how a `.md` with frontmatter is found and read.
 *
 * Agents and pipelines are the same file format, discovered the same way - a
 * directory of `.md` files, and a walk up the parents to the first
 * `.pi/<something>/`. Only what happens to a file *after* it is read differs,
 * and that difference is the point: an agent that does not parse is dropped in
 * silence, a pipeline that does not parse is collected and reported by name.
 * So this file finds and reads; it never decides what a file means.
 *
 * The frontmatter coercions live here too, because "YAML-ish" is a property of
 * the format rather than of either reader: a flag written `true` in a file
 * arrives as the string `"true"` about as often as a boolean.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

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

/** Frontmatter text, trimmed. Blank counts as absent: `name:` with nothing after it says nothing. */
export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A YAML-ish flag: a boolean, or the text `"true"` / `"false"`. */
export function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}
