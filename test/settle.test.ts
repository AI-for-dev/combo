/**
 * How a delivery's work reaches its tree: the decision, the pre-flight, and
 * what a batch coming home amounts to.
 *
 * Real repositories in a temporary directory, like `land.test.ts` next door:
 * what is under test is a policy over git, and a fake git would test only the
 * plumbing between the two.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { emptyUsage } from "../src/usage.ts";
import type { Verification } from "../src/verify.ts";
import type { PairResult } from "../src/workflows/deliver/pair.ts";
import { settling } from "../src/workflows/deliver/settle.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A repository holding one file, so patches have something to sit on. */
function repo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-settle-"));
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

/** A pair's result carrying the patch that adds `name`. */
function wrote(name: string, body = "hello"): PairResult {
	const patch = [
		`diff --git a/${name} b/${name}`,
		"new file mode 100644",
		"index 0000000..1111111",
		"--- /dev/null",
		`+++ b/${name}`,
		"@@ -0,0 +1 @@",
		`+${body}`,
		"",
	].join("\n");
	return { agent: "coder", input: `write ${name}`, output: "done", messages: [], usage: emptyUsage(), ok: true, steps: [], rounds: 1, approved: true, obligations: [], patch };
}

/** A check that counts how often it ran, and says what the script says. */
function check(outcomes: boolean[] = []) {
	const ran = { calls: 0 };
	const verify = async (): Promise<Verification> => {
		const ok = outcomes[ran.calls] ?? true;
		ran.calls++;
		return { ok, output: ok ? "green" : "red", command: "check" };
	};
	return { verify, ran };
}

describe("the decision", () => {
	test("more than one writer and nothing said: every pair gets a copy", async () => {
		const tree = await settling({ cwd: repo(), writers: 2 });
		assert.ok(tree.ok);
		assert.equal(tree.value.isolate, true);
	});

	test("one writer and nothing said: it writes where it was told to", async () => {
		const tree = await settling({ cwd: repo(), writers: 1 });
		assert.ok(tree.ok);
		assert.equal(tree.value.isolate, false);
	});

	test("what the caller said is obeyed as written, whatever the number", async () => {
		const many = await settling({ cwd: repo(), writers: 3, worktree: false });
		const one = await settling({ cwd: repo(), writers: 1, worktree: true });
		assert.ok(many.ok && one.ok);
		assert.equal(many.value.isolate, false);
		assert.equal(one.value.isolate, true);
	});
});

describe("the pre-flight", () => {
	test("isolation chosen by default is refused before any work when the patches could not come home", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "kept.txt"), "somebody else's change\n");

		const tree = await settling({ cwd: dir, writers: 2 });

		assert.equal(tree.ok, false);
		assert.match((tree as { error: string }).error, /2 subtasks need a copy of the repository each/);
		assert.match((tree as { error: string }).error, /worktree: false \(`--worktree=false`\)/, "both ways out, in both spellings");
	});

	test("isolation asked for explicitly is the caller's problem, and is not second-guessed", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "kept.txt"), "somebody else's change\n");

		const tree = await settling({ cwd: dir, writers: 2, worktree: true });
		assert.ok(tree.ok);
	});

	test("a shared tree needs no pre-flight: nothing has to come home", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "kept.txt"), "somebody else's change\n");
		assert.ok((await settling({ cwd: dir, writers: 1 })).ok);
	});
});

describe("settling a batch", () => {
	test("in copies: the patches land one at a time, the check runs between them, and the last check is the tree", async () => {
		const dir = repo();
		const { verify, ran } = check();
		const ready = await settling({ cwd: dir, writers: 2, verify });
		assert.ok(ready.ok);

		const verification = await ready.value.settle([wrote("a.txt"), wrote("b.txt")]);

		assert.equal(verification?.ok, true);
		assert.equal(ran.calls, 2, "once after each patch");
		assert.ok(fs.existsSync(path.join(dir, "a.txt")) && fs.existsSync(path.join(dir, "b.txt")));
		assert.deepEqual(ready.value.landings.map((one) => one.applied), [["write a.txt", "write b.txt"]]);
		assert.equal(ready.value.landed, true);
	});

	test("a second batch lands onto the tree the first one filled: only the first meets a tree it did not write", async () => {
		const dir = repo();
		const ready = await settling({ cwd: dir, writers: 2 });
		assert.ok(ready.ok);

		await ready.value.settle([wrote("a.txt")]);
		const again = await ready.value.settle([wrote("fix.txt")]);

		assert.equal(again, undefined, "no check configured, so nothing is said about the tree");
		assert.equal(ready.value.landings.length, 2);
		assert.equal(ready.value.landed, true);
		assert.ok(fs.existsSync(path.join(dir, "fix.txt")));
	});

	test("a patch that is refused makes the delivery undelivered, and says which one", async () => {
		const dir = repo();
		const ready = await settling({ cwd: dir, writers: 2 });
		assert.ok(ready.ok);

		await ready.value.settle([wrote("a.txt"), { ...wrote("a.txt", "again"), input: "write a.txt again" }]);

		assert.equal(ready.value.landed, false);
		assert.equal(ready.value.landings[0]?.rejected, "write a.txt again");
	});

	test("a batch that wrote nothing still asks the check, so the tree is not left unsaid", async () => {
		const dir = repo();
		const { verify, ran } = check();
		const ready = await settling({ cwd: dir, writers: 2, verify });
		assert.ok(ready.ok);

		const verification = await ready.value.settle([{ ...wrote("a.txt"), patch: "" }]);

		assert.equal(ran.calls, 1);
		assert.equal(verification?.ok, true);
	});

	test("with a shared tree, settling is the check and nothing else", async () => {
		const dir = repo();
		const { verify, ran } = check([false]);
		const ready = await settling({ cwd: dir, writers: 1, verify });
		assert.ok(ready.ok);

		const verification = await ready.value.settle([wrote("a.txt")]);

		assert.equal(ran.calls, 1);
		assert.equal(verification?.ok, false);
		assert.ok(!fs.existsSync(path.join(dir, "a.txt")), "the work was written where the pair ran, not landed");
		assert.deepEqual(ready.value.landings, []);
		assert.equal(ready.value.landed, true, "nothing had to come home");
	});
});
