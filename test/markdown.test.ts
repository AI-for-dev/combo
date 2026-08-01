/**
 * Finding and reading definitions on disk.
 *
 * The two readers that share this - agents and pipelines - are tested through
 * their own files; what is pinned here is the contract between them, on a real
 * temporary directory, because a discovery walk mocked away discovers nothing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { findProjectDir, readMarkdownDir } from "../src/markdown.ts";

const scratch: string[] = [];

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-markdown-"));
	scratch.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readMarkdownDir", () => {
	test("every `.md`, by name, whatever the filesystem returns", () => {
		const dir = tmpDir();
		for (const name of ["zebra.md", "alpha.md", "notes.txt"]) fs.writeFileSync(path.join(dir, name), "x");
		fs.mkdirSync(path.join(dir, "sub.md"));

		assert.deepEqual(
			readMarkdownDir(dir).map((file) => file.name),
			["alpha", "zebra"],
			"sorted, no .txt, and a directory called *.md is not a file",
		);
	});

	test("a file carries its path and its content", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, "one.md"), "---\nname: one\n---\nbody");

		const [file] = readMarkdownDir(dir);
		assert.equal(file?.filePath, path.join(dir, "one.md"));
		assert.match(file?.content ?? "", /name: one/);
	});

	test("a directory that is not there is the normal case, not an error", () => {
		assert.deepEqual(readMarkdownDir(path.join(tmpDir(), "nope")), []);
	});
});

describe("findProjectDir", () => {
	test("walks up to the first `.pi/<sub>`", () => {
		const root = tmpDir();
		const target = path.join(root, ".pi", "agents");
		fs.mkdirSync(target, { recursive: true });
		const deep = path.join(root, "src", "workflows");
		fs.mkdirSync(deep, { recursive: true });

		assert.equal(findProjectDir(deep, "agents"), target);
		assert.equal(findProjectDir(deep, "pipelines"), undefined, "another subdirectory is not a match");
	});

	test("gives up at the root rather than looping", () => {
		assert.equal(findProjectDir(tmpDir(), "definitely-not-a-directory-name"), undefined);
	});
});
