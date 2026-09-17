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
import { scratchWorktree } from "../src/scratch.ts";

const scratch: string[] = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

	test("a copy nobody wrote in releases an empty patch", async () => {
		const dir = repo();
		const made = await scratchWorktree(dir, "work");
		assert.ok(made.ok);
		if (!made.ok) return;

		const released = await made.value.release();
		assert.equal(released.ok ? released.value : "x", "");
	});

	test("releasing twice is not an error, and does not try to remove what is gone", async () => {
		const dir = repo();
		const made = await scratchWorktree(dir, "work");
		assert.ok(made.ok);
		if (!made.ok) return;

		assert.equal((await made.value.release()).ok, true);
		assert.equal((await made.value.release()).ok, true, "safe to call in a `finally`");
	});

	test("a directory that is no repository fails before anything is made", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-not-a-repo-"));
		scratch.push(dir);

		const made = await scratchWorktree(dir, "work");
		assert.equal(made.ok, false);
	});
});
