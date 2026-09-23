/**
 * The `check` node end to end: its keys at the flow stage, its script and
 * port at the run stage, what running it gives, and its scripted answer in a
 * dry run. A real `bash` runs a real script in a temporary directory.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { checkFlow, checkRun, dryRunFlow, runFlow, type CheckedCheckNode, type FlowPorts } from "../src/flow/index.ts";
import { bashCheck } from "../src/verify.ts";
import { AGENTS, checked, flowSpawn, launched } from "./fixtures/flow.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A working tree holding each script of `scripts` under `.pi/checks/`. */
function tree(scripts: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-flow-check-"));
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, ".pi", "checks"), { recursive: true });
	for (const [name, content] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, ".pi", "checks", name), content);
	return dir;
}

const PORTS: FlowPorts = { check: bashCheck() };

/** A flow of one check, `tests`, with `keys` beside it. */
const TESTS = (keys = "") => checked(`  - id: tests\n    check: .pi/checks/tests.sh${keys}`, {});

/** The faults of the flow `f` whose nodes are `nodes`, as `code at`. */
function refused(nodes: string, body = ""): string[] {
	const content = `---\nname: f\ndescription: d\ninput: string\nnodes:\n${nodes}\n---\n${body}`;
	const result = checkFlow("f", { flows: [{ name: "f", filePath: "flows/f.md", content }], agents: AGENTS, brokenAgents: [], cwd: "." });
	assert.ok(!result.ok, "expected the flow to be refused");
	return result.faults.map(({ code, at }) => `${code} ${at}`);
}

describe("a check node, read", () => {
	test("names a script from the repository root, bounded by two minutes unless it says otherwise", () => {
		const [short, long] = [TESTS(), TESTS("\n    timeout: 10m")].map((flow) => flow.nodes[0] as CheckedCheckNode);
		assert.deepEqual([short?.script, short?.timeoutMs, long?.timeoutMs], [".pi/checks/tests.sh", 120_000, 600_000]);
	});

	test("refuses `retry:`, saying what to do instead, and a path outside the repository", () => {
		const retry = `  - id: tests\n    check: .pi/checks/tests.sh\n    retry: 1`;
		assert.deepEqual(refused(retry), ["retry-refused tests.retry"]);
		assert.deepEqual(refused("  - id: a\n    check: /usr/bin/true\n  - id: b\n    check: ../other/tests.sh\n  - id: c\n    check: [x]"), ["key-type a.check", "key-type b.check", "key-type c.check"]);
		assert.deepEqual(refused("  - id: tests\n    check: t.sh\n    reads: [input]"), ["unknown-key tests.reads"]);
	});

	test("hands on `{ passed, report }`, which a condition reads, and has no section", () => {
		const nodes = `  - id: fix\n    loop: tests.output.passed\n    max: 2\n    do:\n      - id: code\n        agent: scout\n      - id: tests\n        check: t.sh`;
		assert.ok(checked(nodes, { code: "Code." }).nodes.length === 1);
		assert.deepEqual(refused(nodes.replace("tests.output.passed", "tests.output.pass"), "## code\nCode."), ["condition-unknown-address fix.loop"]);
		assert.deepEqual(refused("  - id: tests\n    check: t.sh", "## tests\nRun."), ["section-not-agent tests"]);
	});
});

describe("the run stage", () => {
	test("reads each script once, and refuses a missing one and a missing port once each", () => {
		const two = checked("  - id: a\n    check: .pi/checks/gone.sh\n  - id: b\n    check: .pi/checks/gone.sh\n  - id: c\n    check: .pi/checks", {});
		const result = checkRun(two, { cwd: tree({}), ports: {}, somebodyThere: false });
		assert.deepEqual(!result.ok && result.faults.map(({ code, at }) => `${code} ${at}`), ["check-port-missing a.check", "check-script-missing a.check", "check-script-missing c.check"]);
		assert.match(!result.ok ? (result.faults[2]?.message ?? "") : "", /is a directory/);
	});

	test("holds the content it read, and that is what runs, whatever the file says later", async () => {
		const cwd = tree({ "tests.sh": "echo before; exit 0" });
		const run = launched(TESTS(), { cwd, ports: PORTS });
		fs.writeFileSync(path.join(cwd, ".pi", "checks", "tests.sh"), "echo after; exit 1");
		const result = await runFlow(run, "x");
		assert.deepEqual(result.ok && result.output, { passed: true, report: "before" });
	});
});

describe("a check, run", () => {
	test("is green on exit 0 and red on any other, both a value; it runs in the run's tree, `$0` its path", async () => {
		const cwd = tree({ "tests.sh": 'echo "$0 in $(basename "$PWD")"; echo oops >&2; exit 0', "red.sh": "no-such-command-here" });
		const flow = checked("  - id: green\n    check: .pi/checks/tests.sh\n  - id: red\n    check: .pi/checks/red.sh\n  - id: read\n    agent: scout\n    reads: [green, red.output.passed]", { read: "Read." });
		const fake = flowSpawn([[{ text: "read" }]]);
		const result = await runFlow(launched(flow, { cwd, ports: PORTS }), "x", { spawn: fake.spawn });
		assert.ok(result.ok);
		assert.match(fake.created[0]?.prompts[0] ?? "", new RegExp(`"report": ".pi/checks/tests.sh in ${path.basename(cwd)}\\\\noops"[\\s\\S]*## red.output.passed\\n\\n\`\`\`json\\nfalse`));
	});

	test("that could not start fails `unavailable`, and one past its bound fails `timeout`, without waiting on what it left running", async () => {
		const cwd = tree({ "tests.sh": "sleep 30 & sleep 30" });
		const unavailable = await runFlow(launched(TESTS(), { cwd, ports: { check: bashCheck("no-such-bash") } }), "x");
		assert.deepEqual(!unavailable.ok && [unavailable.error.kind, unavailable.path], ["unavailable", "tests"]);
		const started = performance.now();
		const late = await runFlow(launched(TESTS("\n    timeout: 1s"), { cwd, ports: PORTS }), "x");
		assert.deepEqual(!late.ok && late.error, { kind: "timeout", message: "`.pi/checks/tests.sh` ran past its bound of 1000 ms" });
		assert.ok(performance.now() - started < 3_000, "the script and what it started are killed at the bound");
	});

	test("is stopped with the run, `on-fail: continue` absorbing a failure the flow then reads", async () => {
		const cwd = tree({ "tests.sh": "sleep 30" });
		const stop = new AbortController();
		setTimeout(() => stop.abort(), 100);
		const started = performance.now();
		const stopped = await runFlow(launched(TESTS(), { cwd, ports: PORTS }), "x", { signal: stop.signal });
		assert.deepEqual(!stopped.ok && stopped.error.kind, "stopped");
		assert.ok(performance.now() - started < 3_000);
		const flow = checked("  - id: tests\n    check: .pi/checks/tests.sh\n    on-fail: continue\n  - id: gate\n    choice:\n      - when: tests.error.kind == \"unavailable\"\n        do:\n          - id: say\n            agent: scout\n    default: []", { say: "Say." });
		const result = await runFlow(launched(flow, { cwd, ports: { check: bashCheck("no-such-bash") } }), "x", { spawn: flowSpawn([[{ text: "said" }]]).spawn });
		assert.deepEqual(result.ok && result.output, { case: "1", output: "said" });
	});
});

describe("a check in a dry run", () => {
	const FLOW = checked("  - id: fix\n    loop: tests.output.passed\n    max: 2\n    do:\n      - id: code\n        agent: scout\n      - id: tests\n        check: .pi/checks/nowhere.sh", { code: "Code." });

	test("is answered by the script, reads no file and runs nothing", async () => {
		const run = await dryRunFlow(FLOW, "x", { "fix/code": "done", "fix/tests": [{ passed: false, report: "1 failed" }, { passed: true, report: "ok" }] });
		assert.ok(run.ok && "journal" in run, JSON.stringify(run));
		assert.deepEqual(run.journal.filter((entry) => entry.path.endsWith("tests")).map((entry) => entry.output), [{ passed: false, report: "1 failed" }, { passed: true, report: "ok" }]);
	});

	test("fails the way a check can, and a hole in the script is unscripted", async () => {
		const failed = await dryRunFlow(FLOW, "x", { "fix/code": "done", "fix/tests": { fail: "timeout" } });
		assert.deepEqual(!failed.ok && "error" in failed && [failed.error.kind, failed.path], ["timeout", "fix#1/tests"]);
		const hole = await dryRunFlow(FLOW, "x", { "fix/code": "done" });
		assert.deepEqual(!hole.ok && "unscripted" in hole && hole.unscripted, "fix#1/tests");
	});

	test("refuses an answer off `{ passed, report }`, a kind a check cannot fail with, and a list past the loop", async () => {
		const run = await dryRunFlow(FLOW, "x", { "fix/tests": [{ passed: "yes" }, { fail: "schema" }, { passed: true, report: "" }] });
		assert.deepEqual(!run.ok && "faults" in run && run.faults.map(({ code, at }) => `${code} ${at}`), ["answer-off-schema fix/tests[0]", "answer-fail-kind fix/tests[1]", "answer-past-max fix/tests"]);
	});
});
