/**
 * `resumeFlow` on real run directories: a run killed at a visit, read back
 * from its snapshot and journal, carried on under its lock, on its branch,
 * and in the copies it left open. A kill is what it leaves on disk: a
 * journal cut short and a lock whose process is gone.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { gitPort } from "../src/git/index.ts";
import { checkFlow, readJournal, resumeFlow, runFlow, type CheckedFlow, type FlowPorts, type JournalEntry, type Resumed } from "../src/flow/index.ts";
import { JOURNAL_FILE } from "../src/flow/run/journal.ts";
import { heldBy, LOCK_FILE, takeLock, type Lock } from "../src/flow/run/lock.ts";
import { bashCheck, type CheckScript } from "../src/verify.ts";
import { catalogueOf, checked, flowSpawn, flowText, launched } from "./fixtures/flow.ts";
import { git, plainDirectory, repository } from "./fixtures/repo.ts";
import { waitFor } from "./fixtures/wait-for.ts";

const PORTS: FlowPorts = { git: gitPort(), check: bashCheck() };

/** A pid no process holds: one that just exited. */
const DEAD = spawnSync(process.execPath, ["-e", ""]).pid as number;

/** Leaves in `runDir` what a kill just before the visit `path` ended would have: the journal up to there, and the lock of a process gone. */
function kill(runDir: string, path: string): JournalEntry[] {
	const journal = readJournal(runDir);
	const kept = journal.slice(0, journal.findIndex((entry) => entry.type === "visit_end" && entry.path === path));
	fs.writeFileSync(`${runDir}/${JOURNAL_FILE}`, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	lock(runDir, DEAD);
	return kept;
}

function lock(runDir: string, pid: number, host = hostname()): void {
	fs.writeFileSync(path.join(runDir, LOCK_FILE), JSON.stringify({ pid, host }));
}

/** The visits the journal of `runDir` holds past its first `kept` entries. */
function resumedVisits(runDir: string, kept: readonly JournalEntry[]): string[] {
	return readJournal(runDir)
		.slice(kept.length)
		.flatMap((entry) => (entry.type === "visit_end" ? [entry.path] : []));
}

function refusal(resumed: Resumed): string {
	return !resumed.ok && "refused" in resumed ? resumed.refused : JSON.stringify(resumed);
}

describe("a resume", () => {
	test("carries a killed run on under its lock, from its snapshot, with fresh subagents", async () => {
		const cwd = fs.realpathSync(plainDirectory());
		const text = flowText("  - id: look\n    agent: scout\n  - id: more\n    agent: planner\n    reads: [look]", { look: "Look.", more: "More." });
		fs.mkdirSync(path.join(cwd, "flows"));
		fs.writeFileSync(path.join(cwd, "flows/f.md"), text);
		const found = checkFlow("f", { ...catalogueOf({ f: text }), cwd });
		assert.ok(found.ok);
		const runDir = path.join(cwd, "run");
		await runFlow(await launched(found.flow, { cwd }), "x", { spawn: flowSpawn([[{ text: "seen" }], [{ text: "planned" }]]).spawn, runDir, timeoutMs: 60_000 });
		const kept = kill(runDir, "more");

		const again = { ports: {}, somebodyThere: false };
		assert.match(refusal(await resumeFlow(runDir, { ...again, model: "p/m" })), /`model` cannot be given again/);
		lock(runDir, process.pid);
		assert.equal(refusal(await resumeFlow(runDir, again)), `the run is already running, in process ${process.pid}`);
		lock(runDir, process.pid, "elsewhere");
		assert.match(refusal(await resumeFlow(runDir, again)), new RegExp(`locked by \`${path.join(runDir, LOCK_FILE)}\`, taken on elsewhere: remove it by hand`));
		lock(runDir, DEAD);

		fs.writeFileSync(path.join(cwd, "flows/f.md"), "changed");
		const fake = flowSpawn([[{ text: "planned again" }]]);
		const resumed = await resumeFlow(runDir, { ...again, spawn: fake.spawn, timeoutMs: 1_000 });
		assert.ok(resumed.ok, JSON.stringify(resumed));
		assert.deepEqual([resumed.output, resumed.from, resumed.changed], ["planned again", "more", "`flows/f.md` changed since the run started; resuming the version it started with"]);
		// One subagent, fresh: its turn is the whole turn, `look`'s output read back from the journal.
		assert.deepEqual(fake.requested.map(({ agent }) => agent.name), ["planner"]);
		assert.match(fake.created[0]?.prompts[0] ?? "", /## look\n\nseen\n/);
		assert.deepEqual(resumedVisits(runDir, kept), ["more"]);
		assert.equal(fs.existsSync(path.join(runDir, LOCK_FILE)), false);
	});

	test("holds to the run's branch, and never switches to it", async () => {
		const cwd = repository({ "a.txt": "a\n" });
		const flow = checked("  - id: m1\n    agent: scout\n  - id: c1\n    commit: m1\n  - id: m2\n    agent: scout\n  - id: c2\n    commit: m2", { m1: "Message.", m2: "Message." });
		const runDir = path.join(fs.realpathSync(plainDirectory()), "run");
		await runFlow(await launched(flow, { cwd, ports: PORTS }), "x", { spawn: flowSpawn([[{ text: "first" }], [{ text: "second" }]]).spawn, runDir });
		const kept = kill(runDir, "m2");
		fs.writeFileSync(path.join(cwd, "b.txt"), "b\n");
		const resume = () => resumeFlow(runDir, { ports: PORTS, somebodyThere: false, spawn: flowSpawn([[{ text: "second again" }]]).spawn });

		git(cwd, "switch", "main");
		assert.equal(refusal(await resume()), "`HEAD` is not on the run's branch: `git switch combo/x`, then resume");
		git(cwd, "branch", "-m", "combo/x", "combo/y");
		assert.equal(refusal(await resume()), "the run's branch `combo/x` is gone: a new run is how to start again");
		git(cwd, "branch", "-m", "combo/y", "combo/x");
		git(cwd, "switch", "combo/x");

		const resumed = await resume();
		assert.ok(resumed.ok, JSON.stringify(resumed));
		assert.deepEqual(resumedVisits(runDir, kept), ["m2", "c2"]);
		assert.deepEqual([git(cwd, "branch", "--show-current"), git(cwd, "log", "-1", "--format=%s"), git(cwd, "branch", "--list", "combo/*")], ["combo/x", "second again", "* combo/x"]);
	});

	test("takes back a copy left open, and starts over a branch whose copy is gone", async () => {
		const cwd = repository({ ".pi/checks/a.sh": "echo a > a.txt", ".pi/checks/b.sh": "echo b > b.txt" });
		const branch = (name: string) => `      ${name}:\n        - id: w${name}\n          check: .pi/checks/${name}.sh\n`;
		const flow: CheckedFlow = checked(`  - id: both\n    copies: true\n    parallel:\n${branch("a")}${branch("b")}`, {});
		const runDir = path.join(fs.realpathSync(plainDirectory()), "run");
		// The first process dies inside `b`'s check: its copy is left open, `a`'s was released when `a` ended.
		const real = bashCheck();
		const dying: CheckScript = (request) => (request.script.endsWith("b.sh") ? new Promise(() => {}) : real(request));
		void runFlow(await launched(flow, { cwd, ports: { ...PORTS, check: dying } }), "x", { runDir });
		const opened = () => readJournal(runDir).filter((entry) => entry.type === "copy_opened");
		await waitFor(() => fs.existsSync(path.join(runDir, JOURNAL_FILE)) && opened().length === 2 && !fs.existsSync(opened().find((entry) => entry.path === "both/a")?.dir as string), 10_000);
		const kept = readJournal(runDir);
		lock(runDir, DEAD);

		const resumed = await resumeFlow(runDir, { ports: PORTS, somebodyThere: false });
		assert.ok(resumed.ok, JSON.stringify(resumed));
		const facts = readJournal(runDir)
			.slice(kept.length)
			.map((entry) => `${entry.type} ${"path" in entry ? entry.path : ""}`.trim());
		// `b` runs again in the copy it had, so only `a` opens one; the branches run together, in either order.
		assert.deepEqual(facts.slice(0, 4).sort(), ["copy_lost both/a", "copy_opened both/a", "visit_end both/a/wa", "visit_end both/b/wb"]);
		assert.deepEqual(facts.slice(4), ["copy_landed both/a", "copy_landed both/b", "visit_end both", "run_end"]);
		assert.deepEqual([fs.readFileSync(path.join(cwd, "a.txt"), "utf-8"), fs.readFileSync(path.join(cwd, "b.txt"), "utf-8")], ["a\n", "b\n"]);
		assert.equal(git(cwd, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
	});
});

describe("a stale lock", () => {
	/** Two takers of one stale lock, the second run whole just after the first's `at`-th read of it: `[first, second]`, and what the directory holds once the winner released. */
	function race(at: number): [Lock | string, Lock | string, string[]] {
		const runDir = fs.realpathSync(plainDirectory());
		lock(runDir, DEAD);
		let reads = 0;
		let second: Lock | string = "never ran";
		const first = takeLock(runDir, (file) => {
			const held = heldBy(file);
			if (++reads === at) second = takeLock(runDir);
			return held;
		});
		assert.deepEqual(heldBy(path.join(runDir, LOCK_FILE)), { pid: process.pid, host: hostname() });
		for (const taker of [first, second]) if (typeof taker !== "string") taker.release();
		return [first, second, fs.readdirSync(runDir)];
	}
	const running = `the run is already running, in process ${process.pid}`;

	test("goes to one taker when the other took it over between the first's read and its takeover", () => {
		const [first, second, left] = race(1);
		assert.equal(first, running);
		assert.equal(typeof second, "object");
		assert.deepEqual(left, []);
	});

	test("goes to one taker when the other comes in while the first is taking it over", () => {
		const [first, second, left] = race(2);
		assert.equal(typeof first, "object");
		assert.equal(second, running);
		assert.deepEqual(left, []);
	});
});
