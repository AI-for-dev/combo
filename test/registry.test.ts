/**
 * The queue on a repository's list of copies, on a real repository: two
 * commands on it never run at once, from a copy as from the repository.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { gitOnRegistry } from "../src/git/registry.ts";
import { createWorktree } from "../src/git/worktree.ts";
import { repository } from "./fixtures/repo.ts";

test("a command queued from a copy never overlaps one queued on the repository", async () => {
	const repo = repository();
	const copy = `${repo}-copy`;
	assert.ok((await createWorktree(repo, { path: copy, branch: "copy" })).ok);
	const order = path.join(repo, "order");
	// A git alias that writes when it starts and when it ends, a pause between:
	// two at once would interleave, whichever goes first.
	const bracket = (word: string) => ["-c", `alias.bracket=!echo ${word} >> '${order}'; sleep 0.2; echo ${word} >> '${order}'`, "bracket"];
	try {
		const done = await Promise.all([gitOnRegistry(repo, bracket("a")), gitOnRegistry(copy, bracket("b"))]);
		assert.deepEqual(done.map((one) => one.ok), [true, true], JSON.stringify(done));
		assert.match(fs.readFileSync(order, "utf-8"), /^(a\na\nb\nb|b\nb\na\na)\n$/);
	} finally {
		fs.rmSync(copy, { recursive: true, force: true });
	}
});
