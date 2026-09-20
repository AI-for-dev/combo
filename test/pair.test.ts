import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { APPROVAL, pair } from "../src/workflows/pair.ts";
import { VERDICT_TOOL } from "../src/verdict.ts";
import { callTool } from "./fixtures/call-tool.ts";
import { fakeSpawn, offeredTools, testAgent } from "./fixtures/fake-subagent.ts";

const worker = testAgent("coder", { description: "Writes code" });
const reviewer = testAgent("reviewer", { description: "Reviews code" });

/** The reviewer approves at round `n`; the worker echoes what it was given. */
const approvesAt = (n: number) => {
	let round = 0;
	return fakeSpawn((task, agent) => {
		if (agent.name !== "reviewer") return { output: `work after ${task.slice(0, 12)}` };
		round++;
		return { output: round >= n ? APPROVAL : `remark ${round}: fix the parser` };
	});
};

describe("pair", () => {
	test("returns the worker's work, not the reviewer's verdict", async () => {
		const fake = approvesAt(1);
		const result = await pair({ worker, reviewer, input: "implement the parser", spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.equal(result.agent, "coder");
		assert.match(result.output, /^work after/, "handing `LGTM` to the next step would be useless");
		assert.equal(result.review?.output, APPROVAL);
	});

	test("the remarks go back to the worker, round after round", async () => {
		const fake = approvesAt(3);
		const result = await pair({ worker, reviewer, input: "implement the parser", spawn: fake.spawn });

		assert.equal(result.rounds, 3);
		assert.equal(result.approved, true);

		const toWorker = fake.asks.filter((ask) => ask.id.startsWith("coder"));
		assert.equal(toWorker.length, 3);
		assert.match(toWorker[1]?.task ?? "", /remark 1: fix the parser/, "round two starts from the remarks");
		assert.match(toWorker[2]?.task ?? "", /remark 2/);
	});

	test("the reviewer is told the goal, not only the summary", async () => {
		const fake = approvesAt(1);
		await pair({ worker, reviewer, input: "implement the parser", spawn: fake.spawn });

		const toReviewer = fake.asks.find((ask) => ask.id.startsWith("reviewer"));
		assert.match(toReviewer?.task ?? "", /implement the parser/);
		assert.match(toReviewer?.task ?? "", /Read the code itself/, "a review of a summary is not a review");
	});

	test("running out of rounds is not an approval", async () => {
		const fake = approvesAt(99);
		const result = await pair({ worker, reviewer, input: "x", maxRounds: 2, spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.equal(result.ok, true, "every turn ran fine; the bar was simply never reached");
		assert.equal(result.rounds, 2);
		assert.equal(result.steps.length, 4);
	});

	test("the last round says it is the last one", async () => {
		const fake = approvesAt(99);
		await pair({ worker, reviewer, input: "x", maxRounds: 2, spawn: fake.spawn });

		const toWorker = fake.asks.filter((ask) => ask.id.startsWith("coder"));
		assert.match(toWorker[1]?.task ?? "", /last round/);
	});

	test("a custom approval replaces the LGTM convention", async () => {
		const fake = fakeSpawn((_task, agent) => ({ output: agent.name === "reviewer" ? "ship it" : "work" }));
		const result = await pair({
			worker,
			reviewer,
			input: "x",
			approved: (review) => review.output.includes("ship it"),
			spawn: fake.spawn,
		});

		assert.equal(result.approved, true);
		assert.equal(result.rounds, 1);
	});

	test("a failing worker stops the pair: there is nothing to review", async () => {
		const fake = fakeSpawn((_task, agent) => (agent.name === "coder" ? { ok: false, error: "provider exploded" } : {}));
		const result = await pair({ worker, reviewer, input: "x", spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.approved, false);
		assert.equal(fake.asks.length, 1, "the reviewer was never called");
	});

	test("a failing reviewer stops the pair: there is nothing to fix", async () => {
		const fake = fakeSpawn((_task, agent) => (agent.name === "reviewer" ? { ok: false, error: "review exploded" } : {}));
		const result = await pair({ worker, reviewer, input: "x", spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.equal(result.steps.at(-1)?.error, "review exploded");
		assert.equal(result.ok, true, "the work itself is what is returned, and it succeeded");
	});

	test("cancellation: nothing is spawned", async () => {
		const fake = approvesAt(1);
		const result = await pair({ worker, reviewer, input: "x", signal: AbortSignal.abort(), spawn: fake.spawn });

		assert.equal(fake.spawned.length, 0);
		assert.equal(result.error, "aborted");
		assert.equal(result.approved, false);
	});

	test("everything opened is closed", async () => {
		const fake = approvesAt(2);
		await pair({ worker, reviewer, input: "x", spawn: fake.spawn });

		assert.deepEqual(
			fake.closed.sort(),
			fake.spawned.map((entry) => entry.id).sort(),
		);
	});

	test("lifetime: a team by default, strangers on request", async () => {
		const team = approvesAt(3);
		await pair({ worker, reviewer, input: "x", spawn: team.spawn });

		const strangers = approvesAt(3);
		await pair({ worker, reviewer, input: "x", lifetime: "task", spawn: strangers.spawn });

		assert.equal(team.spawned.length, 2, "one worker and one reviewer, for the whole conversation");
		assert.equal(strangers.spawned.length, 6, "a fresh pair every round");
	});

	test("an option nobody set stays unset: `lifetime: undefined` must not defeat the default", async () => {
		// A caller that builds its options object by spreading - a pipeline runner,
		// an extension mapping tool arguments - produces `{ lifetime: undefined }`
		// for an option nobody filled in. Spread over a default, an explicit
		// `undefined` wins, and the pair silently loses its memory.
		const fake = approvesAt(3);
		await pair({ worker, reviewer, input: "x", lifetime: undefined, spawn: fake.spawn });

		assert.equal(fake.spawned.length, 2, "unset is not `task`: the team survives an undefined");
	});

	test("maxRounds below one is a programming error", async () => {
		await assert.rejects(() => pair({ worker, reviewer, input: "x", maxRounds: 0 }), /at least 1/);
	});
});

describe("pair, when the reviewer decides through the verdict tool", () => {
	const judge = testAgent("reviewer", { description: "Reviews code", tools: ["read", VERDICT_TOOL] });

	/** A reviewer that calls the tool at round `n`, and refuses before that. */
	const decidesAt = (n: number) => {
		let round = 0;
		return fakeSpawn(async (_task, agent, options) => {
			if (agent.name !== "reviewer") return { output: "work done" };
			round++;
			const tool = offeredTools(options)[0];
			assert.ok(tool, "the reviewer is offered the tool it declared");
			await callTool(tool, round >= n ? { approved: true } : { approved: false, remarks: `round ${round}: short form` });
			return { output: `round ${round}: the parser drops the last token, src/parse.ts:12` };
		});
	};

	test("the tool call decides, and the prose beside it is not read", async () => {
		const fake = decidesAt(1);
		const result = await pair({ worker, reviewer: judge, input: "implement the parser", spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.deepEqual(result.verdict, { approved: true, remarks: undefined, resolved: [], raised: [] });
		assert.equal(result.rounds, 1);
	});

	test("the worker gets the review itself, not the verdict's summary of it", async () => {
		const fake = decidesAt(2);
		const result = await pair({ worker, reviewer: judge, input: "implement the parser", spawn: fake.spawn });

		assert.equal(result.approved, true);
		const toWorker = fake.asks.filter((ask) => ask.id.startsWith("coder"));
		const second = toWorker[1]?.task ?? "";
		assert.match(second, /src\/parse\.ts:12/, "the prose the reviewer's definition disciplines");
		assert.doesNotMatch(second, /short form/, "the tool carries the decision, not the argument for it");
	});

	test("the short form stays on the result, for whoever reads the outcome", async () => {
		const fake = decidesAt(99);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 1, spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.deepEqual(result.verdict, { approved: false, remarks: "round 1: short form", resolved: [], raised: [] });
	});

	test("only the reviewer is offered the tool", async () => {
		const fake = decidesAt(1);
		await pair({ worker, reviewer: judge, input: "x", spawn: fake.spawn });

		const offered = fake.spawned.map((one) => [one.agent, offeredTools(one.options).length]);
		assert.deepEqual(offered, [
			["coder", 0],
			["reviewer", 1],
		]);
	});

	test("a reviewer that calls nothing has not approved, and the result says it never decided", async () => {
		const fake = fakeSpawn((_task, agent) =>
			agent.name === "reviewer" ? { output: `Looks fine to me. ${APPROVAL}` } : { output: "work done" },
		);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 2, spawn: fake.spawn });

		assert.equal(result.approved, false, "prose is not a decision once the tool is the channel");
		assert.equal(result.verdict, undefined, "absent, not `approved: false`: it never answered");
		assert.equal(result.rounds, 2);
	});

	test("a reviewer that declares nothing keeps the word", async () => {
		const fake = approvesAt(1);
		const result = await pair({ worker, reviewer, input: "x", spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.equal(result.verdict, undefined);
		assert.deepEqual(result.obligations, []);
		assert.deepEqual(offeredTools(fake.spawned[1]?.options ?? {}), []);
	});
});

describe("pair, with a ledger of obligations", () => {
	const judge = testAgent("reviewer", { description: "Reviews code", tools: ["read", VERDICT_TOOL] });

	/** A reviewer driven round by round: what it raises, resolves, and decides. */
	const scripted = (rounds: Record<string, unknown>[]) => {
		let round = 0;
		return fakeSpawn(async (task, agent, options) => {
			if (agent.name !== "reviewer") return { output: "work done" };
			const tool = offeredTools(options)[0];
			assert.ok(tool);
			await callTool(tool, rounds[round++] ?? { approved: true });
			return { output: `saw: ${task.slice(-120)}` };
		});
	};

	test("an obligation keeps its id across rounds, and is listed until it closes", async () => {
		const fake = scripted([
			{ approved: false, raised: ["the parser drops the last token"] },
			{ approved: true, resolved: [{ id: "o1", how: "addressed" }] },
		]);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 3, spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.equal(result.rounds, 2);
		assert.deepEqual(
			result.obligations.map((one) => [one.id, one.openedAt, one.closed?.at]),
			[["o1", 1, 2]],
		);

		const second = fake.asks.filter((ask) => ask.id.startsWith("reviewer"))[1]?.task ?? "";
		assert.match(second, /Still open, from your earlier rounds:\no1: the parser drops the last token/);
	});

	test("a withdrawal closes it, and keeps the reason it was dropped for", async () => {
		const fake = scripted([
			{ approved: false, raised: ["the parser drops the last token"] },
			{ approved: true, resolved: [{ id: "o1", how: "withdrawn", reason: "the code already did it" }] },
		]);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 2, spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.deepEqual(result.obligations[0]?.closed, { how: "withdrawn", reason: "the code already did it", at: 2 });
	});

	test("an id the reviewer never raised closes nothing", async () => {
		const fake = scripted([
			{ approved: false, raised: ["one"] },
			{ approved: true, resolved: [{ id: "o7", how: "addressed" }] },
		]);
		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 2, spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.equal(result.obligations.length, 1, "a resolution naming nothing raises nothing either");
	});

});

describe("pair, when the reviewer names an id nothing is open for", () => {
	const judge = testAgent("reviewer", { description: "Reviews code", tools: ["read", VERDICT_TOOL] });

	test("it is told so in the same breath, and the call still counts", async () => {
		const seen: string[] = [];
		const fake = fakeSpawn(async (_task, agent, options) => {
			if (agent.name !== "reviewer") return { output: "work done" };
			const tool = offeredTools(options)[0];
			assert.ok(tool);

			// What a small open-weight model did in a real run: an id in a format
			// it invented, for a line nothing had raised.
			const answer = await callTool(tool, { approved: true, resolved: [{ id: "1", how: "addressed" }] });
			seen.push(answer.content[0]?.text ?? "");

			await callTool(tool, { approved: false, raised: ["the parser drops the last token"] });
			return { output: "prose" };
		});

		const result = await pair({ worker, reviewer: judge, input: "x", maxRounds: 1, spawn: fake.spawn });

		assert.match(seen[0] ?? "", /Recorded: approved\..*Nothing was closed for 1/s);
		assert.equal(result.approved, false, "the second call is the one that counted");
		assert.equal(result.obligations.length, 1);
	});
});

describe("pair, given a working copy of its own", () => {
	const scratchRepos: string[] = [];
	afterEach(() => {
		for (const dir of scratchRepos.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	/** A repository with one commit in it, so `HEAD` exists. */
	function repo(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-pair-repo-"));
		scratchRepos.push(dir);
		const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		run("init", "--initial-branch=main");
		run("config", "user.email", "test@example.com");
		run("config", "user.name", "Test");
		fs.writeFileSync(path.join(dir, "kept.txt"), "one\n");
		run("add", "-A");
		run("commit", "-m", "first");
		return dir;
	}

	test("both agents work in the same copy, and it is not the caller's tree", async () => {
		const dir = repo();
		const seen: string[] = [];
		const fake = fakeSpawn((_task, agent, options) => {
			seen.push(options.cwd ?? "(none)");
			return { output: agent.name === "reviewer" ? APPROVAL : "work" };
		});

		const result = await pair({ worker, reviewer, input: "x", cwd: dir, worktree: true, spawn: fake.spawn });

		assert.equal(seen.length, 2);
		assert.equal(seen[0], seen[1], "a reviewer elsewhere would read the code the worker did not touch");
		assert.notEqual(seen[0], dir);
		assert.equal(result.worktree, undefined, "nothing was written, so no branch names anything");
		assert.equal(
			execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: dir, encoding: "utf-8" }).trim(),
			"main",
			"and the copy's own branch was cleared away",
		);
	});

	test("what the worker wrote comes back as a patch, and the caller's tree is untouched", async () => {
		const dir = repo();
		const fake = fakeSpawn((_task, agent, options) => {
			if (agent.name === "coder") fs.writeFileSync(path.join(options.cwd ?? ".", "made.txt"), "written\n");
			return { output: agent.name === "reviewer" ? APPROVAL : "work" };
		});

		const result = await pair({ worker, reviewer, input: "x", cwd: dir, worktree: true, spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.match(result.patch ?? "", /made\.txt/);
		assert.equal(fs.existsSync(path.join(dir, "made.txt")), false);

		// The patch is not the only copy of the work: it is committed on the
		// branch, so a caller that drops the string has still lost nothing.
		assert.match(result.worktree ?? "", /^combo\//);
		const onBranch = execFileSync("git", ["show", "--stat", "--format=%s", result.worktree as string], {
			cwd: dir,
			encoding: "utf-8",
		});
		assert.match(onBranch, /^combo: x/m);
		assert.match(onBranch, /made\.txt/);
	});

	test("the copy is released even when the pair failed", async () => {
		const dir = repo();
		const fake = fakeSpawn((_task, agent) => (agent.name === "coder" ? { ok: false, error: "boom" } : {}));

		const result = await pair({ worker, reviewer, input: "x", cwd: dir, worktree: true, spawn: fake.spawn });

		assert.equal(result.ok, false);
		const left = execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf-8" });
		assert.equal(left.trim().split("\n").length, 1, "whoever opens closes, failure included");
	});

	test("a copy that cannot be made stops the pair rather than writing into the caller's tree", async () => {
		const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "combo-pair-plain-"));
		scratchRepos.push(notARepo);
		const fake = fakeSpawn();

		const result = await pair({ worker, reviewer, input: "x", cwd: notARepo, worktree: true, spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /no working copy/);
		assert.equal(fake.spawned.length, 0, "nothing ran anywhere");
	});

	test("a copy that cannot be released fails the pair, and names where the work is", async () => {
		const dir = repo();
		// A hook that refuses every commit: the copy's work cannot be put
		// anywhere the caller can reach, so the copy has to stay.
		const hooks = path.join(dir, ".git", "hooks");
		fs.mkdirSync(hooks, { recursive: true });
		fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

		const fake = fakeSpawn((_task, agent, options) => {
			if (agent.name === "coder") fs.writeFileSync(path.join(options.cwd ?? ".", "made.txt"), "written\n");
			return { output: agent.name === "reviewer" ? APPROVAL : "work" };
		});

		const result = await pair({ worker, reviewer, input: "x", cwd: dir, worktree: true, spawn: fake.spawn });

		assert.equal(result.approved, true, "the pair itself did its job");
		assert.equal(result.ok, false, "and a pair whose work never came back is not a success");
		assert.match(result.error ?? "", /not released/);

		// The path is the whole point of the message: without it the work is
		// somewhere under the system's temporary directory and nothing says where.
		const stranded = (result.error ?? "").match(/\S*combo-scratch-\S+/)?.[0];
		assert.ok(stranded, "the error names the copy the work is in");
		assert.equal(fs.existsSync(path.join(stranded as string, "made.txt")), true);
		fs.rmSync(path.dirname(stranded as string), { recursive: true, force: true });
	});

	test("without the option nothing touches git at all", async () => {
		const fake = approvesAt(1);
		const result = await pair({ worker, reviewer, input: "x", cwd: "/nowhere-at-all", spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.equal(result.worktree, undefined);
		assert.equal(result.patch, undefined);
	});
});
