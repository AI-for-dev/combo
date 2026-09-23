/**
 * The `commit` node and the `diff` address end to end: their reading at the
 * flow stage, the `git` port at the run stage, what running them does to a
 * real repository, and their scripted answers in a dry run.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { VisitEvent } from "../src/events.ts";
import { gitPort } from "../src/git/index.ts";
import { checkRun, dryRunFlow, runFlow, type FlowPorts } from "../src/flow/index.ts";
import { bashCheck } from "../src/verify.ts";
import { checked, flowSpawn, launched, refused } from "./fixtures/flow.ts";
import { git, plainDirectory, repository } from "./fixtures/repo.ts";

const PORTS: FlowPorts = { git: gitPort(), check: bashCheck() };

/** A message written by `message` from the tree's `diff`, then committed. */
const COMMIT = checked("  - id: message\n    agent: scout\n    reads: [diff]\n  - id: commit\n    commit: message", { message: "Write the commit message." });

/** The outputs of every visit that ended, by path. */
function outputs(events: VisitEvent[]): Record<string, unknown> {
	return Object.fromEntries(events.flatMap((event) => (event.type === "visit_end" ? [[event.path, event.ok ? event.output : event.error]] : [])));
}

describe("a commit node, read", () => {
	test("names an earlier node's text, and refuses `retry:`", () => {
		const message = "  - id: message\n    agent: scout\n";
		const body = "## message\nWrite.";
		assert.deepEqual(refused(`${message}  - id: commit\n    commit: message\n    retry: 1`, body), ["retry-refused commit.retry"]);
		assert.deepEqual(refused(`${message}  - id: commit\n    commit: input`, body), ["key-type commit.commit"]);
		assert.deepEqual(refused(`  - id: commit\n    commit: message\n${message}`, body), ["unknown-address commit.commit"]);
		const typed = "  - id: plan\n    agent: scout\n    output: { text: string, n: number }\n";
		assert.deepEqual(refused(`${typed}  - id: commit\n    commit: plan.output`, "## plan\nPlan."), ["key-type commit.commit"]);
		assert.ok(checked(`${typed}  - id: commit\n    commit: plan.output.text`, { plan: "Plan." }).nodes.length === 2);
	});

	test("is refused in a branch's copy, and as a writer beside branches running at once", () => {
		const branches = (copies: string) => `  - id: m\n    agent: scout\n  - id: both\n${copies}    parallel:\n      a:\n        - id: c\n          commit: m\n      b:\n        - id: look\n          agent: scout`;
		const body = "## m\nM.\n\n## look\nLook.";
		assert.deepEqual(refused(branches("    copies: true\n"), body), ["commit-in-copies both/c.commit"]);
		assert.deepEqual(refused(branches(""), body), ["copies-needed both.copies"]);
	});
});

describe("the run stage", () => {
	test("refuses a commit or a read of `diff` without a `git` port, or outside a repository, once", async () => {
		const faults = async (cwd: string, ports: FlowPorts) => {
			const result = await checkRun(COMMIT, { cwd, ports, somebodyThere: false });
			return result.ok ? [] : result.faults.map(({ code, at }) => `${code} ${at}`);
		};
		assert.deepEqual(await faults(repository(), {}), ["git-port-missing message.reads"]);
		assert.deepEqual(await faults(plainDirectory(), PORTS), ["not-a-repository message.reads"]);
		assert.deepEqual(await faults(repository(), PORTS), []);
	});
});

describe("a commit, run", () => {
	test("commits the tree on a branch of the run's own, from a message written off its diff, new files included", async () => {
		const cwd = repository({ "notes.txt": "hello\n" });
		const fake = flowSpawn([[{ text: "Add notes\n\nThey were missing." }]]);
		const result = await runFlow(await launched(COMMIT, { cwd, ports: PORTS }), "add notes", { spawn: fake.spawn });
		assert.ok(result.ok, JSON.stringify(result));
		assert.match(fake.created[0]?.prompts[0] ?? "", /## diff\n\ndiff --git a\/notes\.txt b\/notes\.txt\nnew file mode[\s\S]*\+hello/);
		const { committed, sha, branch } = result.output as { committed: boolean; sha: string; branch: string };
		assert.deepEqual([committed, branch, sha], [true, "combo/add-notes", git(cwd, "rev-parse", "--short", "HEAD")]);
		assert.deepEqual([git(cwd, "branch", "--show-current"), git(cwd, "log", "-1", "--format=%B"), git(cwd, "status", "--porcelain")], ["combo/add-notes", "Add notes\n\nThey were missing.", ""]);
	});

	test("keeps to one branch, suffixed when its name is taken, and a clean tree is a value", async () => {
		const cwd = repository({ ".pi/checks/more.sh": "echo more > more.txt" });
		git(cwd, "branch", "combo/work");
		const flow = checked("  - id: message\n    agent: scout\n  - id: first\n    commit: message\n  - id: more\n    check: .pi/checks/more.sh\n  - id: again\n    commit: message\n  - id: clean\n    commit: message", { message: "Write." });
		const events: VisitEvent[] = [];
		const result = await runFlow(await launched(flow, { cwd, ports: PORTS }), "work", { spawn: flowSpawn([[{ text: "Work" }]]).spawn, onEvent: (event) => events.push(event as VisitEvent) });
		assert.ok(result.ok);
		const ended = outputs(events) as Record<string, { committed: boolean; branch: string }>;
		assert.deepEqual(["first", "again", "clean"].map((id) => [ended[id]?.committed, ended[id]?.branch]), [[true, "combo/work-2"], [true, "combo/work-2"], [false, "combo/work-2"]]);
		assert.equal(git(cwd, "rev-list", "--count", "main..combo/work-2"), "2");
	});

	test("fails `empty-message` before git is asked, and `unavailable` with git's words when it refuses", async () => {
		const cwd = repository({ "notes.txt": "hello\n" });
		const empty = await runFlow(await launched(COMMIT, { cwd, ports: PORTS }), "x", { spawn: flowSpawn([[{ text: "  \n" }]]).spawn });
		assert.deepEqual(!empty.ok && [empty.error.kind, empty.path], ["empty-message", "commit"]);
		assert.equal(git(cwd, "branch", "--show-current"), "main", "an empty message opens no branch");
		fs.writeFileSync(path.join(cwd, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'no commits today' >&2\nexit 1\n", { mode: 0o755 });
		const hooked = await runFlow(await launched(COMMIT, { cwd, ports: PORTS }), "x", { spawn: flowSpawn([[{ text: "Add" }]]).spawn });
		assert.deepEqual(!hooked.ok && hooked.error.kind, "unavailable");
		assert.match(!hooked.ok ? hooked.error.message : "", /no commits today/);
	});

	test("refuses to commit once `HEAD` left the run's branch, and names the switch to type", async () => {
		const cwd = repository({ "a.txt": "a\n", ".pi/checks/away.sh": "git switch -q -c elsewhere && echo b > b.txt" });
		const flow = checked("  - id: message\n    agent: scout\n  - id: first\n    commit: message\n  - id: away\n    check: .pi/checks/away.sh\n  - id: again\n    commit: message", { message: "Write." });
		const result = await runFlow(await launched(flow, { cwd, ports: PORTS }), "moved", { spawn: flowSpawn([[{ text: "Work" }]]).spawn });
		assert.deepEqual(!result.ok && [result.error.kind, result.path, result.error.message], ["unavailable", "again", "`HEAD` is on `elsewhere`, not on the run's branch: `git switch combo/moved`"]);
	});
});

describe("a commit in a dry run", () => {
	test("is answered by the script, `diff` reading as an empty text, and git is never run", async () => {
		const run = await dryRunFlow(COMMIT, "x", { message: "Add", commit: { committed: true, sha: "abc1234", branch: "combo/x" } });
		assert.deepEqual(run.ok && "journal" in run && run.output, { committed: true, sha: "abc1234", branch: "combo/x" });
		const failed = await dryRunFlow(COMMIT, "x", { message: "Add", commit: { fail: "unavailable" } });
		assert.deepEqual(!failed.ok && "error" in failed && failed.error.kind, "unavailable");
		const empty = await dryRunFlow(COMMIT, "x", { message: " " });
		assert.deepEqual(!empty.ok && "error" in empty && empty.error.kind, "empty-message");
	});

	test("refuses an answer off `{ committed, sha?, branch }`, a kind a commit cannot fail with, and a second answer", async () => {
		const run = await dryRunFlow(COMMIT, "x", { commit: [{ committed: "yes", branch: "b" }, { fail: "timeout" }] });
		assert.deepEqual(!run.ok && "faults" in run && run.faults.map(({ code, at }) => `${code} ${at}`), ["answer-off-schema commit[0]", "answer-fail-kind commit[1]", "answer-past-max commit"]);
	});
});
