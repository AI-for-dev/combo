import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AUDIT_APPROVAL, auditPrompt, deliver } from "../src/workflows/deliver.ts";
import { APPROVAL } from "../src/workflows/pair.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

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
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "build a parser", spawn: fake.spawn });

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

	test("the auditor is given the names it may hand a fix to", async () => {
		const fake = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

		const audit = fake.asks.find((ask) => ask.id.startsWith("auditor"))?.task ?? "";
		assert.match(audit, /coder, scribe/, "an auditor that does not know the names invents one");
		assert.match(audit, /`agent:` is not a name/);
	});

	test("the audit reads the brief and what each subtask claims, and is told to check the code", async () => {
		const fake = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "build a parser", spawn: fake.spawn });

		const audit = fake.asks.find((ask) => ask.id.startsWith("auditor"))?.task ?? "";
		assert.match(audit, /build a parser/);
		assert.match(audit, /coder did:/);
		assert.match(audit, /the seams/, "per-task reviews already covered each task on its own");
		assert.match(audit, /claims, not evidence/);
	});

	test("an audit that asks for fixes gets them done, then re-audits", async () => {
		const fake = cast(["coder: the error path is missing", AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

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

	test("an auditor that never approves is ok but not approved", async () => {
		const fake = cast(["coder: again", "coder: again", "coder: again"]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", maxAuditRounds: 2, spawn: fake.spawn });

		assert.equal(result.approved, false);
		assert.equal(result.ok, true, "every turn ran; the bar was never reached");
		assert.equal(result.audits.length, 2, "and it stopped at the cap");
	});

	test("an audit with nothing actionable stops the cycle instead of repeating it", async () => {
		const fake = cast(["I am not sure this is right, honestly.", AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

		assert.equal(result.audits.length, 1, "asking the same question again would only cost tokens");
		assert.equal(result.approved, false);
	});

	test("a refusal in prose still reaches the worker when there is only one", async () => {
		// Observed for real: a check failed, the auditor explained the fix in
		// English, named nobody, and a correct diagnosis went nowhere.
		const fake = cast(["The quote on line 14 is not closed.", AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers: [coder], reviewer, auditor, brief: "x", spawn: fake.spawn });

		assert.equal(result.audits[0]?.fixes.length, 1);
		assert.equal(result.audits[0]?.fixes[0]?.agent.name, "coder");
		assert.match(result.audits[0]?.fixes[0]?.task ?? "", /quote on line 14/);
		assert.equal(result.approved, true, "and the second audit saw the fix");
	});

	test("with several workers a nameless refusal is still dropped: guessing owns nothing", async () => {
		const fake = cast(["Something is wrong somewhere.", AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

		assert.deepEqual(result.audits[0]?.fixes, []);
	});

	test("a fix naming an unknown agent is dropped, like any other plan", async () => {
		const fake = cast(["ghost: do magic", AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

		assert.deepEqual(result.audits[0]?.fixes, []);
		assert.equal(result.audits.length, 1);
	});

	test("no auditor means no audit, and nothing pretends otherwise", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, brief: "x", spawn: fake.spawn });

		assert.equal(result.audits.length, 0);
		assert.equal(result.approved, true, "with nobody to sign off, the per-task reviews are the bar");
		assert.ok(!fake.spawned.some((entry) => entry.agent === "auditor"));
	});

	test("an unplannable brief stops everything, and says why", async () => {
		const fake = fakeSpawn(() => ({ output: "I would start by reading the code." }));
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

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
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

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
		await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

		assert.ok(fake.maxConcurrent <= 2, `expected at most 2 in flight, saw ${fake.maxConcurrent}`);
	});

	test("cancellation: nothing is spawned", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", signal: AbortSignal.abort(), spawn: fake.spawn });

		assert.equal(fake.spawned.length, 0);
		assert.equal(result.ok, false);
	});

	test("everything opened is closed", async () => {
		const fake = cast(["coder: fix it", AUDIT_APPROVAL]);
		await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

		assert.deepEqual(
			fake.closed.sort(),
			fake.spawned.map((entry) => entry.id).sort(),
		);
	});

	test("lifetime: pairs are a team by default, strangers on request", async () => {
		const team = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "x", maxRounds: 2, spawn: team.spawn });

		const strangers = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "x", maxRounds: 2, lifetime: "task", spawn: strangers.spawn });

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

	test("the auditor is always fresh, whatever the lifetime", async () => {
		const fake = cast(["coder: fix it", AUDIT_APPROVAL]);
		await deliver({ planner, workers, reviewer, auditor, brief: "x", lifetime: "workflow", spawn: fake.spawn });

		const auditors = fake.spawned.filter((entry) => entry.agent === "auditor");
		assert.equal(auditors.length, 2, "the second audit must read the code as it is, not remember approving it");
		assert.ok(auditors.every((entry) => entry.options.lifetime === "task"));
	});

	test("usage covers planning, every pair, and every audit", async () => {
		const fake = fakeSpawn((_task, agent) => {
			const usage = { input: 100 };
			if (agent.name === "planner") return { output: plan, usage };
			if (agent.name === "reviewer") return { output: APPROVAL, usage };
			if (agent.name === "auditor") return { output: AUDIT_APPROVAL, usage };
			return { output: "did it", usage };
		});
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

		// planner + (coder + reviewer) + (scribe + reviewer) + auditor
		assert.equal(result.usage.turns, 6);
		assert.equal(result.usage.input, 600);
	});

	test("the run settings reach every level", async () => {
		const fake = cast();
		await deliver({ planner, workers, reviewer, auditor, brief: "x", cwd: "/somewhere", exportDir: "/tmp/run", spawn: fake.spawn });

		assert.ok(fake.spawned.every((entry) => entry.options.cwd === "/somewhere"));
		assert.equal(fake.exported.length, fake.spawned.length);
	});
});

describe("verification", () => {
	const passing = async () => ({ ok: true, output: "12 tests passed", command: "npm test" });
	const failing = async () => ({ ok: false, output: "1 test failed: slugify", command: "npm test" });

	test("a passing check is evidence the auditor gets to see", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", verify: passing, spawn: fake.spawn });

		assert.equal(result.verification?.ok, true);
		assert.equal(result.approved, true);
		const audit = fake.asks.find((ask) => ask.id.startsWith("auditor"))?.task ?? "";
		assert.match(audit, /npm test/);
		assert.match(audit, /12 tests passed/);
	});

	test("a failing check outranks the auditor's approval", async () => {
		const fake = cast([AUDIT_APPROVAL, AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", verify: failing, spawn: fake.spawn });

		assert.equal(result.approved, false, "reading code is not running it");
		assert.equal(result.verification?.ok, false);
	});

	test("the auditor is told the check failed, and that it is not an opinion", async () => {
		const fake = cast(["coder: fix the import", AUDIT_APPROVAL]);
		await deliver({ planner, workers, reviewer, auditor, brief: "x", verify: failing, spawn: fake.spawn });

		const audit = fake.asks.find((ask) => ask.id.startsWith("auditor"))?.task ?? "";
		assert.match(audit, /FAILED/);
		assert.match(audit, /not an opinion/);
	});

	test("the check runs again after the fixes, and can turn the run around", async () => {
		let attempt = 0;
		const verify = async () => {
			attempt++;
			return { ok: attempt > 1, output: attempt > 1 ? "all good" : "boom", command: "npm test" };
		};
		const fake = cast(["coder: fix the import", AUDIT_APPROVAL]);
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", verify, spawn: fake.spawn });

		assert.equal(attempt, 2, "the fixes are worth nothing until the check has seen them");
		assert.equal(result.approved, true);
	});

	test("with no check configured, nothing pretends one ran", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, auditor, brief: "x", spawn: fake.spawn });

		assert.equal(result.verification, undefined);
		const audit = fake.asks.find((ask) => ask.id.startsWith("auditor"))?.task ?? "";
		assert.ok(!audit.includes("own check was run"));
	});

	test("a check runs even with no auditor at all", async () => {
		const fake = cast();
		const result = await deliver({ planner, workers, reviewer, brief: "x", verify: failing, spawn: fake.spawn });

		assert.equal(result.approved, false, "the check is the bar when nobody else is watching");
	});
});

describe("auditPrompt", () => {
	test("says plainly what a failed or unapproved subtask is", () => {
		const prompt = auditPrompt(
			"the brief",
			[
				{ agent: "coder", output: "done", ok: true, approved: true, rounds: 1, steps: [], usage: {} as never, messages: [] },
				{ agent: "scribe", output: "", ok: false, error: "boom", approved: false, rounds: 1, steps: [], usage: {} as never, messages: [] },
			],
			1,
			2,
		);

		assert.match(prompt, /coder \(reviewed and approved\)/);
		assert.match(prompt, /scribe \(failed: boom\)/);
	});

	test("the last audit says so, so it does not open a debate it cannot finish", () => {
		assert.match(auditPrompt("x", [], 2, 2), /last audit/);
		assert.ok(!auditPrompt("x", [], 1, 2).includes("last audit"));
	});
});
