/**
 * A working copy with a lifetime, on real throwaway repositories.
 *
 * What is pinned here is the order the three primitives go in: the patch is
 * taken before the copy goes, and a patch that could not be taken leaves
 * everything where it is.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { scratchWorktree } from "../src/git/scratch.ts";

const scratch: string[] = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Makes every commit in `dir` fail, the way a repository's own hooks can. */
function refusesCommits(dir: string): void {
	const hooks = path.join(dir, ".git", "hooks");
	fs.mkdirSync(hooks, { recursive: true });
	fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
}

/** A repository with one commit in it, so `HEAD` exists. */
function repo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-scratch-repo-"));
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

describe("scratchWorktree", () => {
	test("a copy outside the repository, on a branch named after the work", async () => {
		const dir = repo();
		const made = await scratchWorktree(dir, "add a slugify helper");
		assert.equal(made.ok, true);
		if (!made.ok) return;

		assert.match(made.value.branch, /^combo\/add-a-slugify-helper-/);
		assert.equal(made.value.path.startsWith(dir), false, "inside the tree, it would show up in its own patch");
		assert.equal(fs.readFileSync(path.join(made.value.path, "kept.txt"), "utf8"), "one\n");

		await made.value.release();
	});

	test("two copies of one repository never share a branch", async () => {
		const dir = repo();
		const one = await scratchWorktree(dir, "same label");
		const two = await scratchWorktree(dir, "same label");
		assert.ok(one.ok && two.ok);
		if (!(one.ok && two.ok)) return;

		assert.notEqual(one.value.branch, two.value.branch);
		assert.notEqual(one.value.path, two.value.path);

		await one.value.release();
		await two.value.release();
	});

	test("releasing gives the patch and takes everything else away", async () => {
		const dir = repo();
		const made = await scratchWorktree(dir, "work");
		assert.ok(made.ok);
		if (!made.ok) return;

		fs.writeFileSync(path.join(made.value.path, "kept.txt"), "two\n");
		fs.writeFileSync(path.join(made.value.path, "made.txt"), "brand new\n");

		const released = await made.value.release();
		assert.equal(released.ok, true);
		assert.match(released.ok ? released.value : "", /\+two/);
		assert.match(released.ok ? released.value : "", /made\.txt/);

		assert.equal(fs.existsSync(made.value.path), false, "the copy is gone");
		assert.equal(fs.readFileSync(path.join(dir, "kept.txt"), "utf8"), "one\n", "and the repository is untouched");
	});

	test("a copy nobody wrote in releases an empty patch, and leaves no branch", async () => {
		const dir = repo();
		const made = await scratchWorktree(dir, "work");
		assert.ok(made.ok);
		if (!made.ok) return;

		const released = await made.value.release();
		assert.equal(released.ok ? released.value : "x", "");

		const branches = execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: dir, encoding: "utf-8" });
		assert.equal(branches.trim(), "main", "a branch naming no work would only pile up");
	});

	test("the work is committed on the branch, so the patch is not its only copy", async () => {
		const dir = repo();
		const made = await scratchWorktree(dir, "the work");
		assert.ok(made.ok);
		if (!made.ok) return;

		fs.writeFileSync(path.join(made.value.path, "made.txt"), "written\n");
		await made.value.release();

		const shown = execFileSync("git", ["show", "--stat", "--format=%s", made.value.branch], {
			cwd: dir,
			encoding: "utf-8",
		});
		assert.match(shown, /^combo: the work$/m);
		assert.match(shown, /made\.txt/);
	});

	test("releasing twice is not an error, and gives back the same patch", async () => {
		const dir = repo();
		const made = await scratchWorktree(dir, "work");
		assert.ok(made.ok);
		if (!made.ok) return;
		fs.writeFileSync(path.join(made.value.path, "made.txt"), "written\n");

		const first = await made.value.release();
		const again = await made.value.release();

		assert.ok(first.ok && again.ok, "safe to call in a `finally`");
		assert.equal(again.ok ? again.value : "", first.ok ? first.value : "x", "a second call must not empty it");
	});

	test("a subject too long for a log is cut, not carried whole", async () => {
		const dir = repo();
		const made = await scratchWorktree(dir, "Add src/slugify.js exporting slugify(text),\nand a second line of it.");
		assert.ok(made.ok);
		if (!made.ok) return;

		fs.writeFileSync(path.join(made.value.path, "made.txt"), "written\n");
		await made.value.release();

		const line = execFileSync("git", ["log", "-1", "--format=%s", made.value.branch], {
			cwd: dir,
			encoding: "utf-8",
		}).trim();
		assert.ok(line.length <= 72, `git folds a multi-line subject into one: ${line.length} characters`);
	});

	test("work that cannot be committed leaves the copy, and says why", async () => {
		const dir = repo();
		refusesCommits(dir);
		const made = await scratchWorktree(dir, "work");
		assert.ok(made.ok);
		if (!made.ok) return;
		scratch.push(path.dirname(made.value.path));
		fs.writeFileSync(path.join(made.value.path, "made.txt"), "written\n");

		const released = await made.value.release();

		assert.equal(released.ok, false, "a copy whose work is not somewhere else must not be removed");
		assert.equal(fs.existsSync(path.join(made.value.path, "made.txt")), true, "the work is still there to recover");
	});

	test("a repository with no commit yet fails before anything is made", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-scratch-bare-"));
		scratch.push(dir);
		execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "pipe" });

		const made = await scratchWorktree(dir, "work");
		assert.equal(made.ok, false, "there is no `HEAD` to branch a copy from");
	});

	test("a directory that is no repository fails before anything is made", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-not-a-repo-"));
		scratch.push(dir);

		const made = await scratchWorktree(dir, "work");
		assert.equal(made.ok, false);
	});
});
