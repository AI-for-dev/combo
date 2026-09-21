/**
 * Worktrees, on real throwaway repositories.
 *
 * git is local, so this needs no network, and a mocked `execFile` would prove
 * nothing about the copy a caller ends up with. Every test builds its own
 * repository in a temporary directory and deletes it afterwards.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createWorktree, listWorktrees, removeWorktree, worktreePatch } from "../src/git/worktree.ts";

const scratch: string[] = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A repository with one commit in it, so `HEAD` exists. */
function repo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-worktree-"));
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

/** Where a copy of `dir` goes. Outside it, so it is never part of its own diff. */
const beside = (dir: string, name: string) => path.join(path.dirname(dir), `${path.basename(dir)}-${name}`);

describe("createWorktree", () => {
	test("makes a copy on a branch of its own", async () => {
		const dir = repo();
		const at = beside(dir, "one");
		scratch.push(at);

		const made = await createWorktree(dir, { path: at, branch: "combo/one" });

		assert.equal(made.ok, true);
		assert.equal(fs.readFileSync(path.join(at, "kept.txt"), "utf8"), "one\n");
	});

	test("a branch that already exists fails: two children must not share one", async () => {
		const dir = repo();
		const first = beside(dir, "first");
		const second = beside(dir, "second");
		scratch.push(first, second);

		await createWorktree(dir, { path: first, branch: "combo/one" });
		const again = await createWorktree(dir, { path: second, branch: "combo/one" });

		assert.equal(again.ok, false);
		assert.equal(fs.existsSync(second), false);
	});
});

describe("listWorktrees", () => {
	test("the main copy and every other one, with their branches", async () => {
		const dir = repo();
		const at = beside(dir, "one");
		scratch.push(at);
		await createWorktree(dir, { path: at, branch: "combo/one" });

		const listed = await listWorktrees(dir);
		assert.equal(listed.ok, true);
		const branches = (listed.ok ? listed.value : []).map((one) => one.branch);
		assert.deepEqual(branches.sort(), ["combo/one", "main"]);
		assert.ok((listed.ok ? listed.value : []).every((one) => one.head), "every copy reports a commit");
	});
});

describe("worktreePatch", () => {
	test("carries an edit and a file the child created", async () => {
		const dir = repo();
		const at = beside(dir, "one");
		scratch.push(at);
		await createWorktree(dir, { path: at, branch: "combo/one" });

		fs.writeFileSync(path.join(at, "kept.txt"), "two\n");
		fs.writeFileSync(path.join(at, "made.txt"), "brand new\n");

		const patch = await worktreePatch(at, "main");
		assert.equal(patch.ok, true);
		const text = patch.ok ? patch.value : "";
		assert.match(text, /-one\n/, "the edit");
		assert.match(text, /\+two\n/);
		assert.match(text, /made\.txt/, "a new file is the ordinary case, and `git diff` alone would miss it");
		assert.match(text, /\+brand new/);
	});

	test("a copy that changed nothing gives an empty patch, not a failure", async () => {
		const dir = repo();
		const at = beside(dir, "one");
		scratch.push(at);
		await createWorktree(dir, { path: at, branch: "combo/one" });

		const patch = await worktreePatch(at, "main");
		assert.equal(patch.ok, true);
		assert.equal(patch.ok ? patch.value : "x", "");
	});

	test("a patch past the cap is cut, and says so", async () => {
		const dir = repo();
		const at = beside(dir, "one");
		scratch.push(at);
		await createWorktree(dir, { path: at, branch: "combo/one" });
		fs.writeFileSync(path.join(at, "big.txt"), "x\n".repeat(2000));

		const patch = await worktreePatch(at, "main", 500);
		assert.match(patch.ok ? patch.value : "", /\[patch truncated at 500 bytes\]$/);
	});
});

describe("removeWorktree", () => {
	test("a clean copy goes: there is nothing to lose", async () => {
		const dir = repo();
		const at = beside(dir, "one");
		scratch.push(at);
		await createWorktree(dir, { path: at, branch: "combo/one" });

		const gone = await removeWorktree(dir, at, { patched: false });
		assert.equal(gone.ok, true);
		assert.equal(fs.existsSync(at), false);
	});

	test("a copy holding uncaptured work stays, and the error names it", async () => {
		const dir = repo();
		const at = beside(dir, "one");
		scratch.push(at);
		await createWorktree(dir, { path: at, branch: "combo/one" });
		fs.writeFileSync(path.join(at, "made.txt"), "work nobody has\n");

		const refused = await removeWorktree(dir, at, { patched: false });

		assert.equal(refused.ok, false);
		assert.match(refused.ok ? "" : refused.error, /refusing to remove .*: it holds changes no patch was taken of/);
		assert.equal(fs.existsSync(path.join(at, "made.txt")), true, "the work is still there");
	});

	test("the same copy goes once its patch has been taken", async () => {
		const dir = repo();
		const at = beside(dir, "one");
		scratch.push(at);
		await createWorktree(dir, { path: at, branch: "combo/one" });
		fs.writeFileSync(path.join(at, "made.txt"), "work somebody has\n");

		const patch = await worktreePatch(at, "main");
		assert.match(patch.ok ? patch.value : "", /made\.txt/);

		const gone = await removeWorktree(dir, at, { patched: true });
		assert.equal(gone.ok, true);
		assert.equal(fs.existsSync(at), false);
	});
});
