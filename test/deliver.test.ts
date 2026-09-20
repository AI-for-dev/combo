import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { AUDIT_APPROVAL, auditPrompt } from "../src/workflows/audit.ts";
import { deliver } from "../src/workflows/deliver.ts";
import { APPROVAL } from "../src/workflows/pair.ts";
import { emptyUsage } from "../src/usage.ts";
import { VERDICT_TOOL } from "../src/verdict.ts";
import { callTool } from "./fixtures/call-tool.ts";
import { fakeSpawn, offeredTools, testAgent } from "./fixtures/fake-subagent.ts";

const planner = testAgent("planner", { description: "Splits the work" });
const coder = testAgent("coder", { description: "Writes code" });
const scribe = testAgent("scribe", { description: "Writes documentation" });
const reviewer = testAgent("reviewer", { description: "Reviews code" });
const auditor = testAgent("auditor", { description: "Audits the whole" });

const workers = [coder, scribe];

const plan = JSON.stringify([
	{ agent: "coder", task: "write the parser" },
	{ agent: "scribe", task: "document the parser" },
]);

/**
 * A whole cast in one fake: the planner plans, workers work, reviewers approve
 * at once, and the auditor says whatever the script says, round by round.
 */
function cast(audits: string[] = [AUDIT_APPROVAL]) {
	let audit = 0;
	return fakeSpawn((task, agent) => {
		switch (agent.name) {
			case "planner":
				return { output: plan };
			case "reviewer":
				return { output: APPROVAL };
			case "auditor":
				return { output: audits[audit++] ?? AUDIT_APPROVAL };
			default:
				return { output: `${agent.name} did: ${task.slice(0, 30)}` };
		}
	});
}

describe("deliver", () => {
	test("plans, runs each subtask as a pair, and audits the whole", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "build a parser", spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.ok, true);
		assert.equal(result.approved, true);
		assert.equal(result.plan.length, 2);
		assert.equal(result.tasks.length, 2);
		assert.ok(result.tasks.every((task) => task.approved), "each subtask went through its own review");
		assert.equal(result.audits.length, 1);

		// The two pairs run side by side, so the workers appear before their
		// reviewers rather than in neat pairs.
		assert.equal(fake.spawned[0]?.agent, "planner", "nothing is spawned before the plan is validated");
		assert.equal(fake.spawned.at(-1)?.agent, "auditor", "the audit comes last, on the finished whole");
		assert.deepEqual(
			fake.spawned.map((entry) => entry.agent).sort(),
			["auditor", "coder", "planner", "reviewer", "reviewer", "scribe"],
		);
	});

	test("read as one Result: the planner's turn, over every subtask's report", async () => {
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: cast().spawn, worktree: false });

		assert.equal(result.agent, "planner");
		assert.match(result.output, /## coder\n\ncoder did:/);
		assert.match(result.output, /## scribe\n\nscribe did:/);
		assert.equal(result.steps.length, 4, "the planning, two subtasks, one audit");
	});

	test("the auditor is given the names it may hand a fix to", async () => {
		const fake = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		const audit = fake.asks.find((ask) => ask.id.startsWith("auditor"))?.task ?? "";
		assert.match(audit, /coder, scribe/, "an auditor that does not know the names invents one");
		assert.match(audit, /`agent:` is not a name/);
	});

	test("the audit reads the brief and what each subtask claims, and is told to check the code", async () => {
		const fake = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "build a parser", spawn: fake.spawn,
			worktree: false,
		});

		const audit = fake.asks.find((ask) => ask.id.startsWith("auditor"))?.task ?? "";
		assert.match(audit, /build a parser/);
		assert.match(audit, /coder did:/);
		assert.match(audit, /the seams/, "per-task reviews already covered each task on its own");
		assert.match(audit, /claims, not evidence/);
	});

	test("an audit that asks for fixes gets them done, then re-audits", async () => {
		const fake = cast(["coder: the error path is missing", AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.audits.length, 2);
		assert.equal(result.audits[0]?.approved, false);
		assert.deepEqual(
			result.audits[0]?.fixes.map((fix) => `${fix.agent.name}: ${fix.task}`),
			["coder: the error path is missing"],
		);
		assert.equal(result.audits[0]?.results.length, 1, "the fix ran as a pair, like any other subtask");
		assert.equal(result.approved, true);
		assert.equal(result.tasks.length, 3, "the fix joins the record of what was done");
	});

	test("no auditor means no audit, and nothing pretends otherwise", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.audits.length, 0);
		assert.equal(result.approved, true, "with nobody to sign off, the per-task reviews are the bar");
		assert.ok(!fake.spawned.some((entry) => entry.agent === "auditor"));
	});

	test("an unplannable brief stops everything, and says why", async () => {
		const fake = fakeSpawn(() => ({ output: "I would start by reading the code." }));
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /no runnable plan/);
		assert.equal(result.tasks.length, 0);
		assert.equal(fake.spawned.length, 1);
	});

	test("a failing subtask does not stop the others, but the run is not ok", async () => {
		const fake = fakeSpawn((task, agent) => {
			if (agent.name === "planner") return { output: plan };
			if (agent.name === "reviewer") return { output: APPROVAL };
			if (agent.name === "auditor") return { output: AUDIT_APPROVAL };
			if (agent.name === "scribe") return { ok: false, error: "scribe exploded" };
			return { output: `did ${task.slice(0, 10)}` };
		});
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.tasks.length, 2);
		assert.equal(result.tasks[0]?.ok, true);
		assert.equal(result.tasks[1]?.ok, false);
		assert.equal(result.ok, false);
		assert.equal(result.error, "scribe exploded");
	});

	test("concurrency defaults to 2: these workers share one working tree", async () => {
		const fake = fakeSpawn((task, agent) => {
			if (agent.name === "planner") {
				return { output: JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ agent: "coder", task: `task ${i}` }))) };
			}
			if (agent.name === "reviewer") return { output: APPROVAL };
			if (agent.name === "auditor") return { output: AUDIT_APPROVAL };
			return { output: `did ${task}`, delayMs: 10 };
		});
		await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		assert.ok(fake.maxConcurrent <= 2, `expected at most 2 in flight, saw ${fake.maxConcurrent}`);
	});

	test("cancellation: nothing is spawned", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", signal: AbortSignal.abort(), spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(fake.spawned.length, 0);
		assert.equal(result.ok, false);
	});

	test("everything opened is closed", async () => {
		const fake = cast(["coder: fix it", AUDIT_APPROVAL]);
		await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		assert.deepEqual(
			fake.closed.sort(),
			fake.spawned.map((entry) => entry.id).sort(),
		);
	});

	test("lifetime: pairs are a team by default, strangers on request", async () => {
		const team = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "x", maxRounds: 2, spawn: team.spawn,
			worktree: false,
		});

		const strangers = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "x", maxRounds: 2, lifetime: "task", spawn: strangers.spawn,
			worktree: false,
		});

		// Reviewers approve at once here, so both regimes run one round: what the
		// lifetime changes is who the auditor and the pairs are, not the count.
		assert.deepEqual(
			team.spawned.filter((entry) => entry.agent === "reviewer").map((entry) => entry.options.lifetime),
			["workflow", "workflow"],
		);
		assert.deepEqual(
			strangers.spawned.filter((entry) => entry.agent === "reviewer").map((entry) => entry.options.lifetime),
			["task", "task"],
		);
	});

	test("a fix is paid for once: it is in the record of what was done, and the audit round keeps only its review", async () => {
		let audits = 0;
		const fake = fakeSpawn((_task, agent) => {
			const usage = { input: 100 };
			if (agent.name === "planner") return { output: plan, usage };
			if (agent.name === "reviewer") return { output: APPROVAL, usage };
			if (agent.name === "auditor") return { output: ++audits > 1 ? AUDIT_APPROVAL : "coder: fix it", usage };
			return { output: "did it", usage };
		});
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn, worktree: false });

		// planner + 2 pairs (4) + audit + fix pair (2) + audit
		assert.equal(result.usage.turns, 9);
		assert.equal(result.usage.input, 900);
		assert.equal(result.tasks.length, 3, "the fix joins the record of what was done");
	});

	test("usage covers planning, every pair, and every audit", async () => {
		const fake = fakeSpawn((_task, agent) => {
			const usage = { input: 100 };
			if (agent.name === "planner") return { output: plan, usage };
			if (agent.name === "reviewer") return { output: APPROVAL, usage };
			if (agent.name === "auditor") return { output: AUDIT_APPROVAL, usage };
			return { output: "did it", usage };
		});
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		// planner + (coder + reviewer) + (scribe + reviewer) + auditor
		assert.equal(result.usage.turns, 6);
		assert.equal(result.usage.input, 600);
	});

	test("the run settings reach every level", async () => {
		const fake = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "x", cwd: "/somewhere", exportDir: "/tmp/run", spawn: fake.spawn,
			worktree: false,
		});

		assert.ok(fake.spawned.every((entry) => entry.options.cwd === "/somewhere"));
		assert.equal(fake.exported.length, fake.spawned.length);
	});
});

describe("resuming", () => {
	const previously = (over: Partial<Parameters<typeof deliver>[0]["resume"] & object> = {}) => ({
		plan: [
			{ agent: coder, task: "write the parser" },
			{ agent: scribe, task: "document the parser" },
		],
		tasks: [
			{
				agent: "coder",
				input: "write the parser",
				output: "the parser, from last time",
				messages: [],
				usage: emptyUsage(),
				ok: true,
				steps: [],
				rounds: 1,
				approved: true,
				obligations: [],
			},
		],
		audits: [],
		obligations: [],
		...over,
	});

	test("the plan is reused, and an approved subtask is not paid for twice", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", resume: previously(), spawn: fake.spawn,
			worktree: false,
		});

		assert.ok(!fake.spawned.some((entry) => entry.agent === "planner"), "the plan was already paid for");
		assert.deepEqual(
			fake.spawned.map((entry) => entry.agent),
			["scribe", "reviewer", "auditor"],
			"only the subtask nobody had approved ran again",
		);
		assert.equal(result.tasks.length, 2, "and the kept one is still part of the result");
		assert.equal(result.tasks[0]?.output, "the parser, from last time");
	});

	test("a subtask that was not approved runs again: nobody signed off on that tree", async () => {
		const fake = cast();
		const unfinished = previously({
			tasks: [
				{
					agent: "coder",
					input: "write the parser",
					output: "half of it",
					messages: [],
					usage: emptyUsage(),
					ok: true,
					steps: [],
					rounds: 3,
					approved: false,
					obligations: [],
				},
			],
		});
		await deliver({ planner, workers, reviewer, auditor, brief: "x", resume: unfinished, spawn: fake.spawn,
			worktree: false,
		});

		assert.ok(fake.spawned.some((entry) => entry.agent === "coder"), "an argued-over subtask is not a finished one");
	});

	test("progress is reported after the plan, the subtasks and every audit", async () => {
		const reported: { tasks: number; done: boolean }[] = [];
		const fake = cast(["coder: fix it", AUDIT_APPROVAL]);
		await deliver({
			planner,
			workers,
			reviewer,
			auditor,
			brief: "x",
			onProgress: (progress, done) => reported.push({ tasks: progress.tasks.length, done }),
			spawn: fake.spawn,
			worktree: false,
		});

		assert.ok(reported.length >= 3, `expected several reports, got ${reported.length}`);
		assert.equal(reported[0]?.tasks, 0, "the first one carries the plan, before any work");
		assert.equal(reported.at(-1)?.done, true, "and the last one says it is over");
		assert.ok(reported.slice(0, -1).every((step) => !step.done));
	});

	test("a listener that throws does not take the build down", async () => {
		const fake = cast();
		const result = await deliver({
			planner,
			workers,
			reviewer,
			auditor,
			brief: "x",
			onProgress: () => {
				throw new Error("bookkeeping exploded");
			},
			spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.ok, true);
	});
});

describe("verification", () => {
	const passing = async () => ({ ok: true, output: "12 tests passed", command: "npm test" });
	const failing = async () => ({ ok: false, output: "1 test failed: slugify", command: "npm test" });

	test("a passing check is evidence the auditor gets to see", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", verify: passing, spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.verification?.ok, true);
		assert.equal(result.approved, true);
		const audit = fake.asks.find((ask) => ask.id.startsWith("auditor"))?.task ?? "";
		assert.match(audit, /npm test/);
		assert.match(audit, /12 tests passed/);
	});

	test("a failing check outranks the auditor's approval", async () => {
		const fake = cast([AUDIT_APPROVAL, AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", verify: failing, spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.approved, false, "reading code is not running it");
		assert.equal(result.verification?.ok, false);
	});

	test("the check runs again after the fixes, and can turn the run around", async () => {
		let attempt = 0;
		const verify = async () => {
			attempt++;
			return { ok: attempt > 1, output: attempt > 1 ? "all good" : "boom", command: "npm test" };
		};
		const fake = cast(["coder: fix the import", AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", verify, spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(attempt, 2, "the fixes are worth nothing until the check has seen them");
		assert.equal(result.approved, true);
	});

	test("with no check configured, nothing pretends one ran", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.verification, undefined);
		const audit = fake.asks.find((ask) => ask.id.startsWith("auditor"))?.task ?? "";
		assert.ok(!audit.includes("own check was run"));
	});

	test("a check runs even with no auditor at all", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, brief: "x", verify: failing, spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.approved, false, "the check is the bar when nobody else is watching");
	});
});

describe("auditPrompt", () => {
	const ask = (over: Partial<Parameters<typeof auditPrompt>[0]> = {}) =>
		auditPrompt({ brief: "x", tasks: [], round: 1, maxAuditRounds: 2, workers: [], terms: "", byTool: false, ...over });

	test("says plainly what a failed or unapproved subtask is", () => {
		const prompt = ask({
			brief: "the brief",
			tasks: [
				{ agent: "coder", input: "write it", output: "done", ok: true, approved: true, rounds: 1, steps: [], usage: {} as never, messages: [], obligations: [] },
				{
					agent: "scribe",
					input: "document it",
					output: "",
					ok: false,
					error: "boom",
					approved: false,
					rounds: 1,
					steps: [],
					usage: {} as never,
					messages: [],
					obligations: [],
				},
			],
		});

		assert.match(prompt, /coder \(reviewed and approved\)/);
		assert.match(prompt, /scribe \(failed\)\n\nboom/, "the failure is marked where every other report is, its error where the output would be");
	});

	test("a passing check is put to the auditor as evidence, not as a note", () => {
		const prompt = ask({ verification: { ok: true, output: "12 tests passed", command: "npm test" } });

		assert.match(prompt, /passing check is evidence/);
		assert.match(prompt, /handed this same result/, "which is what makes the sentence true");
	});

	test("the last audit says so, so it does not open a debate it cannot finish", () => {
		assert.match(ask({ round: 2 }), /last audit/);
		assert.ok(!ask({ round: 1 }).includes("last audit"));
	});
});

describe("an auditor that signs through the verdict tool", () => {
	const judge = testAgent("auditor", { description: "Audits the whole", tools: ["read", VERDICT_TOOL] });

	/** The same cast, with the auditor driven round by round through its tool. */
	function withVerdicts(rounds: Record<string, unknown>[]) {
		let audit = 0;
		return fakeSpawn(async (task, agent, options) => {
			switch (agent.name) {
				case "planner":
					return { output: plan };
				case "reviewer":
					return { output: APPROVAL };
				case "auditor": {
					const tool = offeredTools(options)[0];
					assert.ok(tool, "the auditor is offered the tool it declared");
					await callTool(tool, rounds[audit++] ?? { approved: true });
					return { output: "prose the decision does not live in" };
				}
				default:
					return { output: `${agent.name} did: ${task.slice(0, 30)}` };
			}
		});
	}

	test("an obligation survives a resume, unlike the subtasks", async () => {
		const first = withVerdicts([{ approved: false, raised: ["coder: one"] }]);
		const stopped = await deliver({
			planner,
			workers,
			reviewer,
			auditor: judge,
			brief: "x",
			maxAuditRounds: 1,
			spawn: first.spawn,
			worktree: false,
		});
		assert.equal(stopped.approved, false);
		assert.equal(stopped.obligations.length, 1);

		const second = withVerdicts([{ approved: true, resolved: [{ id: "o1", how: "addressed" }] }]);
		const carried = await deliver({
			planner,
			workers,
			reviewer,
			auditor: judge,
			brief: "x",
			spawn: second.spawn,
			resume: {
				plan: [
					{ agent: coder, task: "write the parser" },
					{ agent: scribe, task: "document the parser" },
				],
				tasks: [],
				audits: [],
				obligations: stopped.obligations,
			},
			worktree: false,
		});

		assert.equal(carried.approved, true, "the resumed run closed the line it inherited");
		assert.equal(carried.obligations.length, 1, "and raised no duplicate of it");
		assert.equal(carried.obligations[0]?.id, "o1");
	});

});

describe("delivering in copies", () => {
	const scratchDirs: string[] = [];
	afterEach(() => {
		for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	/** A repository holding one file, so patches have something to sit on. */
	function repo(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-deliver-"));
		scratchDirs.push(dir);
		const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		run("init", "--initial-branch=main");
		run("config", "user.email", "test@example.com");
		run("config", "user.name", "Test");
		fs.writeFileSync(path.join(dir, "kept.txt"), "one\n");
		run("add", "-A");
		run("commit", "-m", "first");
		return dir;
	}

	/**
	 * The cast again, with each coder writing a file named after its subtask.
	 *
	 * The write happens in whatever `cwd` the pool handed the subagent, which is
	 * the copy: that is what makes the landing afterwards real work.
	 */
	function writingCast(audits: string[] = [AUDIT_APPROVAL]) {
		let audit = 0;
		return fakeSpawn((task, agent, options) => {
			switch (agent.name) {
				case "planner":
					return { output: plan };
				case "reviewer":
					return { output: APPROVAL };
				case "auditor":
					return { output: audits[audit++] ?? AUDIT_APPROVAL };
				default: {
					const name = task.includes("document") ? "doc.txt" : "code.txt";
					fs.writeFileSync(path.join(options.cwd ?? ".", name), `${agent.name} was here\n`);
					return { output: `${agent.name} wrote ${name}` };
				}
			}
		});
	}

	test("each subtask writes in its own copy, and the work lands in the caller's tree", async () => {
		const dir = repo();
		const fake = writingCast();
		const result = await deliver({
			planner,
			workers,
			reviewer,
			auditor,
			brief: "x",
			cwd: dir,
			worktree: true,
			spawn: fake.spawn,
		});

		assert.equal(result.approved, true);
		assert.equal(result.landings.length, 1, "one batch of subtasks, one landing");
		assert.equal(result.landings[0]?.ok, true);
		assert.equal(result.landings[0]?.applied.length, 2);
		// A report naming its patches by the whole subtask is one nobody reads.
		for (const label of result.landings[0]?.applied ?? []) {
			assert.ok(label.length <= 60, `a landing label stays short: ${label}`);
			assert.ok(!label.includes("\n"), "and on one line");
		}

		assert.equal(fs.readFileSync(path.join(dir, "code.txt"), "utf8"), "coder was here\n");
		assert.equal(fs.readFileSync(path.join(dir, "doc.txt"), "utf8"), "scribe was here\n");
	});

	test("the check runs between the patches, not once at the end", async () => {
		const dir = repo();
		const fake = writingCast();
		const seen: number[] = [];
		let files = 0;

		await deliver({
			planner,
			workers,
			reviewer,
			auditor,
			brief: "x",
			cwd: dir,
			worktree: true,
			spawn: fake.spawn,
			verify: async () => {
				files = fs.readdirSync(dir).filter((name) => name.endsWith(".txt")).length;
				seen.push(files);
				return { ok: true, output: "", command: "check" };
			},
		});

		assert.deepEqual(seen.slice(0, 2), [2, 3], "one file landed, then the other, with a check after each");
	});

	test("a patch that never reached the tree is not a delivery, whatever the auditor said", async () => {
		const dir = repo();
		// Both subtasks rewrite the same line, so the second patch cannot apply.
		const fake = fakeSpawn((task, agent, options) => {
			switch (agent.name) {
				case "planner":
					return { output: plan };
				case "reviewer":
					return { output: APPROVAL };
				case "auditor":
					return { output: AUDIT_APPROVAL };
				default:
					fs.writeFileSync(path.join(options.cwd ?? ".", "kept.txt"), `${agent.name} won\n`);
					return { output: `${agent.name} rewrote it` };
			}
		});

		const result = await deliver({
			planner,
			workers,
			reviewer,
			auditor,
			brief: "x",
			cwd: dir,
			worktree: true,
			spawn: fake.spawn,
		});

		assert.equal(result.approved, false, "the auditor approved, and one patch is still not in");
		assert.equal(result.ok, true, "every turn ran: this is not a model failure");
		assert.equal(result.landings[0]?.ok, false);
		assert.ok(result.landings[0]?.rejected, "and it says which one");
	});

	test("an audit that asks for a fix lands it onto the tree the subtasks filled", async () => {
		const dir = repo();
		// The auditor refuses once, names a fix, then signs off.
		let audit = 0;
		const fake = fakeSpawn((task, agent, options) => {
			switch (agent.name) {
				case "planner":
					return { output: plan };
				case "reviewer":
					return { output: APPROVAL };
				case "auditor":
					return { output: audit++ === 0 ? "coder: add the missing note" : AUDIT_APPROVAL };
				default: {
					const name = task.includes("missing note") ? "note.txt" : task.includes("document") ? "doc.txt" : "code.txt";
					fs.writeFileSync(path.join(options.cwd ?? ".", name), `${agent.name} wrote ${name}\n`);
					return { output: `${agent.name} wrote ${name}` };
				}
			}
		});

		const result = await deliver({
			planner,
			workers,
			reviewer,
			auditor,
			brief: "x",
			cwd: dir,
			worktree: true,
			maxAuditRounds: 2,
			spawn: fake.spawn,
		});

		assert.equal(result.landings.length, 2, "the subtasks, then the audit's fix");
		assert.equal(result.landings[1]?.ok, true, "the second lands onto what the first put there");
		assert.equal(result.approved, true);
		assert.equal(fs.readFileSync(path.join(dir, "note.txt"), "utf8"), "coder wrote note.txt\n");
	});

	test("refused, nothing touches git and no landing is reported", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn,
			worktree: false,
		});

		assert.equal(result.approved, true);
		assert.deepEqual(result.landings, []);
	});

	test("two subtasks get a copy each without anyone asking", async () => {
		const dir = repo();
		const fake = writingCast();

		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", cwd: dir, spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.equal(result.landings.length, 1, "the copies came back, so there was a landing to report");
		// What the option is for: neither worker could read the other's file while
		// it worked, and both of them are in the tree afterwards.
		assert.equal(fs.readFileSync(path.join(dir, "code.txt"), "utf8"), "coder was here\n");
		assert.equal(fs.readFileSync(path.join(dir, "doc.txt"), "utf8"), "scribe was here\n");
	});

	test("one subtask has nobody to leak to, and writes where it was told", async () => {
		const dir = repo();
		const fake = fakeSpawn((task, agent, options) => {
			if (agent.name === "planner") return { output: JSON.stringify([{ agent: "coder", task: "write the parser" }]) };
			if (agent.name === "reviewer") return { output: APPROVAL };
			if (agent.name === "auditor") return { output: AUDIT_APPROVAL };
			fs.writeFileSync(path.join(options.cwd ?? ".", "code.txt"), "coder was here\n");
			return { output: "done" };
		});

		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", cwd: dir, spawn: fake.spawn });

		assert.deepEqual(result.landings, [], "no copy, so nothing to land");
		assert.equal(fs.readFileSync(path.join(dir, "code.txt"), "utf8"), "coder was here\n");
	});

	test("a tree that cannot take the patches back stops the run before it is paid for", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "kept.txt"), "somebody was already working here\n");
		const fake = writingCast();

		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", cwd: dir, spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /2 subtasks need a copy/);
		assert.match(result.error ?? "", /worktree: false/, "and it names the way to run anyway");
		assert.equal(fake.asks.length, 1, "the planner, and nobody else: no subtask was paid for");
	});

	test("asked for explicitly, the same tree is the caller's problem, not a refusal", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "kept.txt"), "somebody was already working here\n");
		const fake = writingCast();

		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", cwd: dir, worktree: true, spawn: fake.spawn });

		assert.ok(fake.asks.length > 1, "the subtasks ran: what was asked for is not second-guessed");
		assert.equal(result.landings[0]?.ok, false, "and the landing is where it fails, as it always did");
	});
});
