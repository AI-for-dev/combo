/**
 * The audit cycle: rounds, what the auditor asks for, and what ends it.
 *
 * Offline, with a fake `spawn` for the auditor and a fake `fix` for what it
 * asks for. How a fix reaches the tree is `deliver`'s and is tested there; what
 * is under test here is the cycle's own rules.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Obligation } from "../src/ledger.ts";
import { emptyUsage } from "../src/usage.ts";
import { VERDICT_TOOL } from "../src/verdict.ts";
import type { Verification } from "../src/verify.ts";
import { audit, AUDIT_APPROVAL, type AuditOptions, type Fixed } from "../src/workflows/audit.ts";
import type { PairResult } from "../src/workflows/pair.ts";
import type { PlannedTask } from "../src/workflows/plan.ts";
import { callTool } from "./fixtures/call-tool.ts";
import { fakeSpawn, offeredTools, testAgent } from "./fixtures/fake-subagent.ts";

const auditor = testAgent("auditor", { description: "Audits the whole" });
const coder = testAgent("coder", { description: "Writes code" });
const scribe = testAgent("scribe", { description: "Writes documentation" });
const workers = [coder, scribe];

/** A subtask as a pair reports it. */
function done(agent: string, input: string, output = `${agent} did it`): PairResult {
	return { agent, input, output, messages: [], usage: { ...emptyUsage(), turns: 2 }, ok: true, steps: [], rounds: 1, approved: true, obligations: [] };
}

const passing: Verification = { ok: true, output: "12 tests passed", command: "npm test" };
const failing: Verification = { ok: false, output: "boom", command: "npm test" };

/** An auditor that says what the script says, round by round. */
const saying = (rounds: string[]) => {
	let round = 0;
	return fakeSpawn(() => ({ output: rounds[round++] ?? AUDIT_APPROVAL }));
};

/** A `fix` that runs nothing, records what it was asked, and answers with a result per fix. */
function fixer(verification?: Verification | ((attempt: number) => Verification)) {
	const asked: PlannedTask[][] = [];
	const fix = async (fixes: readonly PlannedTask[]): Promise<Fixed> => {
		asked.push([...fixes]);
		return {
			results: fixes.map((one) => done(one.agent.name, one.task, `fixed: ${one.task.split("\n")[0]}`)),
			verification: typeof verification === "function" ? verification(asked.length) : verification,
		};
	};
	return { fix, asked };
}

function run(over: Partial<AuditOptions> & { spawn: AuditOptions["spawn"] }) {
	return audit({
		auditor,
		workers,
		brief: "x",
		tasks: [done("coder", "write the parser"), done("scribe", "document the parser")],
		fix: fixer().fix,
		...over,
	});
}

describe("the cycle", () => {
	test("a yes with nothing owed ends it, and what was audited comes back", async () => {
		const fake = saying([AUDIT_APPROVAL]);
		const result = await run({ spawn: fake.spawn });

		assert.equal(result.approved, true);
		assert.equal(result.progress.audits.length, 1);
		assert.equal(result.progress.tasks.length, 2);
		assert.equal(result.progress.audits[0]?.review.output, AUDIT_APPROVAL);
	});

	test("what the auditor asks for is fixed, and the next round reads the fixes", async () => {
		const fake = saying(["coder: the error path is missing", AUDIT_APPROVAL]);
		const { fix, asked } = fixer();
		const result = await run({ spawn: fake.spawn, fix });

		assert.deepEqual(asked[0]?.map((one) => `${one.agent.name}: ${one.task}`), ["coder: the error path is missing"]);
		assert.equal(result.progress.audits.length, 2);
		assert.equal(result.progress.audits[0]?.approved, false);
		assert.deepEqual(result.progress.audits[0]?.fixes.map((one) => one.task), ["the error path is missing"], "the fixes are kept as the auditor named them, without the check attached");
		assert.equal(result.progress.audits[0]?.results.length, 1);
		assert.equal(result.progress.tasks.length, 3, "the fix joins what is audited");
		assert.match(fake.asks[1]?.task ?? "", /fixed: the error path is missing/, "and the second audit reads it");
		assert.equal(result.approved, true);
	});

	test("an auditor that never approves reaches the cap, and that is not approval", async () => {
		const fake = saying(["coder: again", "coder: again", "coder: again"]);
		const result = await run({ spawn: fake.spawn, maxAuditRounds: 2 });

		assert.equal(result.approved, false);
		assert.equal(result.progress.audits.length, 2);
	});

	test("nothing actionable and nothing closed stops the cycle instead of repeating it", async () => {
		const fake = saying(["I am not sure this is right, honestly.", AUDIT_APPROVAL]);
		const result = await run({ spawn: fake.spawn });

		assert.equal(result.progress.audits.length, 1, "asking the same question again would only cost tokens");
		assert.equal(result.approved, false);
	});

	test("the auditor is always fresh, whatever the caller runs with", async () => {
		const fake = saying(["coder: fix it", AUDIT_APPROVAL]);
		await run({ spawn: fake.spawn, lifetime: "workflow" });

		assert.equal(fake.spawned.length, 2, "the second audit must read the code as it is, not remember approving it");
		assert.ok(fake.spawned.every((entry) => entry.options.lifetime === "task"));
	});

	test("rounds a previous run recorded are not spent again", async () => {
		const fake = saying([AUDIT_APPROVAL]);
		const spent = { review: { agent: "auditor", output: "coder: again", messages: [], usage: emptyUsage(), ok: true }, approved: false, fixes: [], results: [] };
		const result = await run({ spawn: fake.spawn, maxAuditRounds: 2, resume: { audits: [spent], obligations: [] } });

		assert.equal(result.progress.audits.length, 2, "the recorded round plus the one it had left");
		assert.equal(fake.spawned.length, 1);
		assert.match(fake.asks[0]?.task ?? "", /round 2/);
		assert.equal(result.steps.length, 2, "read as one Result, the cycle's trail counts the round it inherited");
		assert.equal(result.output, AUDIT_APPROVAL, "and speaks with its last review");
		assert.equal(result.agent, "auditor");
	});

	test("cancellation before the first round audits nothing", async () => {
		const controller = new AbortController();
		controller.abort();
		const fake = saying([AUDIT_APPROVAL]);
		const result = await run({ spawn: fake.spawn, signal: controller.signal });

		assert.equal(fake.spawned.length, 0);
		assert.deepEqual(result.progress.audits, []);
		assert.equal(result.approved, false);
	});

	test("every round is reported as it ends, with the cycle as it stands", async () => {
		const fake = saying(["coder: fix it", AUDIT_APPROVAL]);
		const seen: number[] = [];
		await run({ spawn: fake.spawn, onRound: (progress) => void seen.push(progress.audits.length) });
		assert.deepEqual(seen, [1, 2]);
	});
});

describe("what the auditor asks for", () => {
	test("a refusal in prose still reaches the worker when there is only one", async () => {
		// Observed for real: a check failed, the auditor explained the fix in
		// English, named nobody, and a correct diagnosis went nowhere.
		const fake = saying(["The quote on line 14 is not closed.", AUDIT_APPROVAL]);
		const result = await run({ spawn: fake.spawn, workers: [coder] });

		assert.equal(result.progress.audits[0]?.fixes.length, 1);
		assert.equal(result.progress.audits[0]?.fixes[0]?.agent.name, "coder");
		assert.match(result.progress.audits[0]?.fixes[0]?.task ?? "", /quote on line 14/);
		assert.equal(result.approved, true, "and the second audit saw the fix");
	});

	test("with several workers a nameless refusal is dropped: guessing owns nothing", async () => {
		const fake = saying(["Something is wrong somewhere.", AUDIT_APPROVAL]);
		const result = await run({ spawn: fake.spawn });
		assert.deepEqual(result.progress.audits[0]?.fixes, []);
	});

	test("a fix naming an unknown agent is dropped, like any other plan", async () => {
		const fake = saying(["ghost: do magic", AUDIT_APPROVAL]);
		const result = await run({ spawn: fake.spawn });

		assert.deepEqual(result.progress.audits[0]?.fixes, []);
		assert.equal(result.progress.audits.length, 1);
	});
});

describe("the check", () => {
	test("a yes over a failing check is not approval", async () => {
		const fake = saying([AUDIT_APPROVAL, AUDIT_APPROVAL]);
		const result = await run({ spawn: fake.spawn, verification: failing });

		assert.equal(result.approved, false, "reading code is not running it");
		assert.equal(result.progress.audits.length, 1, "and with nothing asked for, another identical audit would only cost tokens");
	});

	test("the auditor is told the check failed, and that it is not an opinion", async () => {
		const fake = saying(["coder: fix the import", AUDIT_APPROVAL]);
		await run({ spawn: fake.spawn, verification: failing });

		assert.match(fake.asks[0]?.task ?? "", /FAILED/);
		assert.match(fake.asks[0]?.task ?? "", /not an opinion/);
	});

	test("the check a fix brings back is what the next round reads, and what ends the cycle", async () => {
		const fake = saying(["coder: fix the import", AUDIT_APPROVAL]);
		const { fix } = fixer(passing);
		const result = await run({ spawn: fake.spawn, verification: failing, fix });

		assert.match(fake.asks[1]?.task ?? "", /passed/);
		assert.equal(result.progress.verification?.ok, true);
		assert.equal(result.approved, true);
	});

	test("a fix goes out holding the check that was standing when it was asked for", async () => {
		const fake = saying(["coder: the test file has a syntax error", AUDIT_APPROVAL]);
		const { fix, asked } = fixer(passing);
		await run({ spawn: fake.spawn, verification: passing, fix });

		assert.match(asked[0]?.[0]?.task ?? "", /syntax error/, "the remark reaches the worker as the auditor wrote it");
		assert.match(asked[0]?.[0]?.task ?? "", /npm test.*passes on this tree/s, "and so does the evidence against it");
	});

	test("a failing check is not repeated to the worker: the suite is about to say so itself", async () => {
		const fake = saying(["coder: fix the import", AUDIT_APPROVAL]);
		const { fix, asked } = fixer(passing);
		await run({ spawn: fake.spawn, verification: failing, fix });

		assert.ok(!(asked[0]?.[0]?.task ?? "").includes("passes on this tree"));
	});
});

describe("an auditor that signs through the verdict tool", () => {
	const judge = testAgent("auditor", { description: "Audits the whole", tools: ["read", VERDICT_TOOL] });

	/** The auditor driven round by round through its tool; its prose never says anything the decision lives in. */
	function withVerdicts(rounds: Record<string, unknown>[]) {
		let round = 0;
		return fakeSpawn(async (_task, _agent, options) => {
			const tool = offeredTools(options)[0];
			assert.ok(tool, "the auditor is offered the tool it declared");
			await callTool(tool, rounds[round++] ?? { approved: true });
			return { output: "prose the decision does not live in" };
		});
	}

	test("what the tool raises becomes the fixes, and the prose is not read", async () => {
		const fake = withVerdicts([
			{ approved: false, raised: ["coder: name the parser after what it parses"] },
			{ approved: true, resolved: [{ id: "o1", how: "addressed" }] },
		]);
		const result = await run({ spawn: fake.spawn, auditor: judge });

		assert.equal(result.approved, true);
		assert.deepEqual(
			result.progress.obligations.map((one) => [one.id, one.text, one.closed?.at]),
			[["o1", "coder: name the parser after what it parses", 2]],
		);
		assert.deepEqual(result.progress.audits[0]?.fixes.map((fix) => fix.agent.name), ["coder"]);
	});

	test("an id the auditor invented does not cost it the approval", async () => {
		const fake = withVerdicts([{ approved: true, resolved: [{ id: "coder", how: "addressed" }] }]);
		const result = await run({ spawn: fake.spawn, auditor: judge });

		assert.equal(result.approved, true);
		assert.deepEqual(result.progress.obligations, [], "and nothing was closed that was never open");
	});

	test("a refusal that raises nothing sends nobody anywhere", async () => {
		// The shape a real run produced: the auditor writes `APPROVED` in its prose
		// while its call says otherwise, and the prose became a fix task.
		const fake = withVerdicts([{ approved: false, remarks: "not yet" }]);
		const { fix, asked } = fixer();
		const result = await run({ spawn: fake.spawn, auditor: judge, maxAuditRounds: 1, fix });

		assert.equal(result.approved, false);
		assert.deepEqual(result.progress.audits[0]?.fixes, [], "what it wants done goes in `raised`, and it raised nothing");
		assert.deepEqual(asked, []);
	});

	test("the auditor is shown what is still open, by id", async () => {
		const fake = withVerdicts([{ approved: false, raised: ["coder: one"] }, { approved: false, remarks: "still no" }]);
		await run({ spawn: fake.spawn, auditor: judge });

		assert.match(fake.asks[1]?.task ?? "", /Still open, from your earlier rounds:\no1: coder: one/);
	});

	test("an obligation a previous run left open is still open, and keeps its id", async () => {
		const carried: Obligation[] = [{ id: "o1", openedBy: "auditor", text: "coder: one", openedAt: 1 }];
		const fake = withVerdicts([{ approved: true, resolved: [{ id: "o1", how: "addressed" }] }]);
		const result = await run({ spawn: fake.spawn, auditor: judge, resume: { audits: [], obligations: carried } });

		assert.equal(result.approved, true, "the resumed cycle closed the line it inherited");
		assert.deepEqual(result.progress.obligations.map((one) => one.id), ["o1"], "and raised no duplicate of it");
	});
});
