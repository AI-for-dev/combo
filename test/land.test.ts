/**
 * Landing patches, on real throwaway repositories.
 *
 * What is pinned here is the order and what survives a failure: a patch that
 * does not fit touches nothing and stops the rest, and whatever already landed
 * stays landed.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { land } from "../src/git/land.ts";

const scratch: string[] = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A repository holding one file, so patches have something to sit on. */
function repo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-land-"));
	scratch.push(dir);

	const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	run("init", "--initial-branch=main");
	run("config", "user.email", "test@example.com");
	run("config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "kept.txt"), "one\n");
	run("add", "-A");
	run("commit", "-m", "first");
	return dir;
}

/** The patch that adds `name` with `body`. What a copy hands back. */
const adds = (name: string, body: string) =>
	[
		`diff --git a/${name} b/${name}`,
		"new file mode 100644",
		"index 0000000..1111111",
		"--- /dev/null",
		`+++ b/${name}`,
		"@@ -0,0 +1 @@",
		`+${body}`,
		"",
	].join("\n");

/** The patch that rewrites the one line of `kept.txt`. */
const rewrites = (to: string) =>
	[
		"diff --git a/kept.txt b/kept.txt",
		"index 5626abf..1111111 100644",
		"--- a/kept.txt",
		"+++ b/kept.txt",
		"@@ -1 +1 @@",
		"-one",
		`+${to}`,
		"",
	].join("\n");

describe("land", () => {
	test("disjoint patches all go in, in the order they were given", async () => {
		const dir = repo();
		const done = await land(dir, [
			{ label: "one", patch: adds("a.txt", "first") },
			{ label: "two", patch: adds("b.txt", "second") },
		]);

		assert.equal(done.ok, true);
		assert.deepEqual(done.applied, ["one", "two"]);
		assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "first\n");
		assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "second\n");
	});

	test("a patch that does not fit is named, and touches nothing", async () => {
		const dir = repo();
		const done = await land(dir, [
			{ label: "one", patch: rewrites("two") },
			{ label: "two", patch: rewrites("three") },
		]);

		assert.equal(done.ok, false);
		assert.equal(done.rejected, "two");
		assert.deepEqual(done.applied, ["one"], "what landed stays landed");
		assert.equal(fs.readFileSync(path.join(dir, "kept.txt"), "utf8"), "two\n", "and no marker was written into it");
	});

	test("a copy nobody wrote in is skipped rather than failing the landing", async () => {
		const dir = repo();
		const done = await land(dir, [
			{ label: "empty", patch: "" },
			{ label: "one", patch: adds("a.txt", "first") },
		]);

		assert.equal(done.ok, true);
		assert.deepEqual(done.applied, ["one"], "it has no place in the list either");
	});

	test("a tree that already has changes in it is refused before anything is applied", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "kept.txt"), "somebody else was here\n");

		const done = await land(dir, [{ label: "one", patch: adds("a.txt", "first") }]);

		assert.equal(done.ok, false);
		assert.match(done.error ?? "", /already has changes/);
		assert.deepEqual(done.applied, []);
		assert.equal(fs.existsSync(path.join(dir, "a.txt")), false);
	});

	test("a caller that put the changes there itself can say so", async () => {
		const dir = repo();
		const first = await land(dir, [{ label: "one", patch: adds("a.txt", "first") }]);
		assert.equal(first.ok, true);

		const refused = await land(dir, [{ label: "two", patch: adds("b.txt", "second") }]);
		assert.equal(refused.ok, false, "by default the tree it finds is somebody else's");

		const allowed = await land(dir, [{ label: "two", patch: adds("b.txt", "second") }], {
			requireCleanTree: false,
		});
		assert.equal(allowed.ok, true);
		assert.deepEqual(allowed.applied, ["two"]);
	});
});
