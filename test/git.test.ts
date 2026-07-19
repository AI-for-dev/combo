/**
 * git, on real throwaway repositories.
 *
 * git is local: this needs no network, and a mocked `execFile` would prove
 * nothing about the commit a user ends up with. Every test builds its own
 * repository in a temporary directory and deletes it afterwards.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { branchName, commitAll, createBranch, currentBranch, diff, diffStat, isRepository, status, untracked } from "../src/git.ts";

const scratch: string[] = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A repository with one commit in it, so `HEAD` exists. */
function repo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-git-"));
	scratch.push(dir);

	const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	run("init", "--initial-branch=main");
	run("config", "user.email", "test@example.com");
	run("config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
	run("add", "-A");
	run("commit", "-m", "first");
	return dir;
}

const log = (dir: string) => execFileSync("git", ["log", "--format=%s%n%b"], { cwd: dir, encoding: "utf-8" });
const branches = (dir: string) => execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: dir, encoding: "utf-8" });

describe("reading a repository", () => {
	test("recognises a working tree, and says no elsewhere", async () => {
		assert.equal(await isRepository(repo()), true);

		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-plain-"));
		scratch.push(empty);
		assert.equal(await isRepository(empty), false);
	});

	test("names the current branch", async () => {
		assert.equal(await currentBranch(repo()), "main");
	});

	test("a clean tree has an empty status", async () => {
		const dir = repo();
		const result = await status(dir);
		assert.equal(result.ok && result.value.trim(), "");
	});

	test("changes show up in the status, the diff and the diffstat", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "README.md"), "# demo\nmore\n");

		const state = await status(dir);
		assert.match(state.ok ? state.value : "", /README\.md/);

		const stat = await diffStat(dir);
		assert.match(stat.ok ? stat.value : "", /README\.md \|/);

		const patch = await diff(dir);
		assert.match(patch.ok ? patch.value : "", /\+more/);
	});

	test("a huge diff is truncated, and says so: it ends up in a prompt", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "README.md"), `# demo\n${"x".repeat(5_000)}\n`);

		const patch = await diff(dir, 500);
		assert.ok(patch.ok && patch.value.length < 1_000);
		assert.match(patch.ok ? patch.value : "", /truncated at 500 bytes/);
	});

	test("untracked files are listed: git diff hides them, git add -A commits them", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "new.ts"), "export const x = 1;\n");

		assert.deepEqual(await untracked(dir), ["new.ts"]);
		const patch = await diff(dir);
		assert.ok(patch.ok && !patch.value.includes("new.ts"), "which is exactly why they are listed separately");
	});
});

describe("createBranch", () => {
	test("creates the branch and switches to it", async () => {
		const dir = repo();
		const result = await createBranch(dir, "pi-subagent/demo");

		assert.equal(result.ok && result.value, "pi-subagent/demo");
		assert.equal(await currentBranch(dir), "pi-subagent/demo");
	});

	test("refuses an existing branch rather than landing on somebody else's work", async () => {
		const dir = repo();
		await createBranch(dir, "pi-subagent/demo");
		execFileSync("git", ["checkout", "main"], { cwd: dir, stdio: "pipe" });

		const again = await createBranch(dir, "pi-subagent/demo");
		assert.equal(again.ok, false);
		assert.equal(await currentBranch(dir), "main", "and it stays where it was");
	});
});

describe("commitAll", () => {
	test("stages everything and commits it, returning the short sha", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "new.ts"), "export const x = 1;\n");
		fs.writeFileSync(path.join(dir, "README.md"), "# demo\nchanged\n");

		const result = await commitAll(dir, "Add x\n\nBecause the brief asked for it.");

		assert.ok(result.ok, `expected a commit, got ${result.ok ? "" : result.error}`);
		assert.match(result.ok ? result.value : "", /^[0-9a-f]{7,}$/);
		assert.match(log(dir), /Add x/);
		assert.match(log(dir), /Because the brief asked for it\./);

		const after = await status(dir);
		assert.equal(after.ok && after.value.trim(), "", "untracked files included");
	});

	test("a message full of quotes, backticks and newlines survives intact", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "new.ts"), "x\n");
		const message = ['Fix `parse()` on "quoted" input', "", "It used to drop $HOME and `rm -rf /` stayed in the log.", "Nothing was executed."].join("\n");

		const result = await commitAll(dir, message);

		assert.ok(result.ok);
		const written = log(dir);
		assert.match(written, /Fix `parse\(\)` on "quoted" input/);
		assert.match(written, /rm -rf \//, "no shell ever saw this string");
		assert.match(written, /\$HOME/, "and no shell expanded it either");
	});

	test("a clean tree is an error, not an empty commit", async () => {
		const dir = repo();
		const result = await commitAll(dir, "nothing to see");

		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /nothing to commit/);
		assert.equal(log(dir).match(/nothing to see/), null);
	});

	test("an empty message is refused before anything is staged", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "new.ts"), "x\n");

		const result = await commitAll(dir, "   ");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /empty message/);
		assert.deepEqual(await untracked(dir), ["new.ts"], "and nothing was staged");
	});

	test("the branch is where the commit lands, and main is left alone", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "new.ts"), "x\n");

		await createBranch(dir, branchName("add a cache to the loader"));
		await commitAll(dir, "Add a cache");

		assert.match(branches(dir), /pi-subagent\/add-a-cache-to-the-loader/);
		execFileSync("git", ["checkout", "main"], { cwd: dir, stdio: "pipe" });
		assert.equal(log(dir).match(/Add a cache/), null, "main never saw it");
	});
});

describe("branchName", () => {
	test("slugifies the request under a prefix that says where it came from", () => {
		assert.equal(branchName("Add a cache to the loader"), "pi-subagent/add-a-cache-to-the-loader");
		assert.equal(branchName("Fix: the parser!! (again)"), "pi-subagent/fix-the-parser-again");
	});

	test("stays short, and never ends on a dash", () => {
		const name = branchName("a".repeat(80));
		assert.ok(name.length <= "pi-subagent/".length + 40);
		assert.ok(!name.endsWith("-"));
	});

	test("a request with nothing usable still names a branch", () => {
		assert.equal(branchName("!!!"), "pi-subagent/work");
	});
});
