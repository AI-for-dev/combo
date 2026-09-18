/**
 * Landing patches, on real throwaway repositories.
 *
 * What is pinned here is the order and what survives a failure: a patch that
 * does not fit touches nothing, a check that fails stops the rest, and whatever
 * already landed stays landed.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { land } from "../src/land.ts";
import type { Verification } from "../src/verify.ts";

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

/** The patch that adds `name` with `body`. What a pair hands back. */
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

const passes = (): Promise<Verification> => Promise.resolve({ ok: true, output: "", command: "check" });

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

	test("the check runs between them, and its failure names the patch that caused it", async () => {
		const dir = repo();
		let call = 0;
		const verify = async (): Promise<Verification> => ({ ok: ++call < 2, output: "boom", command: "check" });

		const done = await land(
			dir,
			[
				{ label: "one", patch: adds("a.txt", "first") },
				{ label: "two", patch: adds("b.txt", "second") },
				{ label: "three", patch: adds("c.txt", "third") },
			],
			{ verify },
		);

		assert.equal(done.ok, false);
		assert.equal(done.rejected, "two");
		assert.match(done.error ?? "", /the check failed after two/);
		assert.deepEqual(done.applied, ["one", "two"]);
		assert.equal(done.checks.length, 2, "it stopped rather than piling the third onto a broken tree");
		assert.equal(fs.existsSync(path.join(dir, "c.txt")), false);
	});

	test("a pair that wrote nothing is skipped rather than failing the landing", async () => {
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

	test("with no check, nothing runs between them", async () => {
		const dir = repo();
		const done = await land(dir, [{ label: "one", patch: adds("a.txt", "first") }]);

		assert.equal(done.ok, true);
		assert.deepEqual(done.checks, []);
	});

	test("every check is kept, so a reader sees what the tree said at each step", async () => {
		const dir = repo();
		const done = await land(
			dir,
			[
				{ label: "one", patch: adds("a.txt", "first") },
				{ label: "two", patch: adds("b.txt", "second") },
			],
			{ verify: passes },
		);

		assert.equal(done.checks.length, 2);
	});
});
