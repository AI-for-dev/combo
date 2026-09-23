/**
 * The `flow` node checked: its callee resolved and checked whole, broken or
 * not, the call graph refused when it cycles, the input held to the callee's
 * `input:`, the output typed from its last root node, the boundary its scopes
 * stop at, and the rules about the world read through the call, at both
 * stages.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkFlow, checkRun, type CheckedNode } from "../src/flow/index.ts";
import { agent, AGENTS, catalogueOf, checkedIn, flowText, refusedIn } from "./fixtures/flow.ts";

/** A flow `name` whose only node, `spec`, calls `callee` with `input`, then more nodes after it. */
function caller(callee: string, rest = "", input = "input", name = "f", head?: string): string {
	return flowText(`  - id: spec\n    flow: ${callee}\n    input: ${input}${rest}`, {}, head, name);
}

/** A `choice` on the call's output, and the prose of the node it runs. */
const GATE = "\n  - id: gate\n    choice:\n      - when: spec.output.ready\n        do:\n          - id: go\n            agent: scout\n    default: []";
const PROSE = "## go\nGo.";

/** A flow `name` of one agent node, `look`, whose output is `output` when given. */
function looking(name = "g", output = "", head?: string): string {
	return flowText(`  - id: look\n    agent: scout${output === "" ? "" : `\n    output: ${output}`}`, { look: "Look." }, head, name);
}

describe("a flow node, read", () => {
	test("needs `input:`, refuses `retry:`, and has no `model:`, `timeout:` or `output:`", () => {
		const flows = (keys: string) => ({ f: flowText(`  - id: spec\n    flow: g${keys}`), g: looking() });
		assert.deepEqual(refusedIn("f", flows("")), ["missing-key spec.input"]);
		assert.deepEqual(refusedIn("f", flows("\n    input: input\n    retry: 1")), ["retry-refused spec.retry"]);
		assert.deepEqual(refusedIn("f", flows("\n    input: input\n    model: p/m\n    timeout: 1m\n    output: string")), ["unknown-key spec.model", "unknown-key spec.timeout", "unknown-key spec.output"]);
		assert.deepEqual(refusedIn("f", flows("\n    input: add a cache")), ["invalid-address spec.input"], "`input:` is an address, never a literal");
	});

	test("has no prose of its own", () => {
		const f = `${caller("g")}\n## spec\nSpec.`;
		assert.deepEqual(refusedIn("f", { f, g: looking() }), ["section-not-agent spec"]);
	});
});

describe("a callee", () => {
	test("is resolved in the catalogue and attached checked whole, once however many nodes call it", () => {
		const flow = checkedIn("f", { f: caller("g", "\n  - id: again\n    flow: g\n    input: input"), g: looking() });
		const [spec, again] = flow.nodes as Extract<CheckedNode, { kind: "flow" }>[];
		assert.deepEqual([spec?.callee.name, spec?.callee.file, spec?.input], ["g", "flows/g.md", { address: "input", type: { kind: "string" } }]);
		assert.equal(spec?.callee, again?.callee);
	});

	test("unknown is refused with the name meant", () => {
		const result = checkFlow("f", catalogueOf({ f: caller("gg"), g: looking() }));
		assert.deepEqual(!result.ok && result.faults.map(({ code, at, message }) => [code, at, message]), [["unknown-flow", "spec.flow", "`gg` is unknown; did you mean `g`?"]]);
	});

	test("broken makes its caller broken, the fault naming the callee's file and first fault", () => {
		const result = checkFlow("f", catalogueOf({ f: caller("g"), g: flowText("  - id: look\n    agent: scotu\n  - id: more\n    agent: nobody", { look: "L.", more: "M." }, undefined, "g") }));
		assert.deepEqual(!result.ok && result.faults.map(({ code, file, at }) => [code, file, at]), [["broken-flow", "flows/f.md", "spec.flow"]]);
		assert.match(!result.ok ? (result.faults[0]?.message ?? "") : "", /^`g` is flows\/g\.md, which is refused at `look\.agent`: `scotu` is unknown; did you mean `scout`\? \(and 1 more\)$/);
		const unreadable = checkFlow("f", catalogueOf({ f: caller("g"), g: "---\nname: [g\n---\n" }));
		assert.deepEqual(!unreadable.ok && unreadable.faults.map(({ code }) => code), ["broken-flow"], "a file that does not parse is broken, never unknown");
	});

	test("broken is not reported again by what reads the call", () => {
		const f = `${caller("g", GATE)}\n${PROSE}`;
		assert.deepEqual(refusedIn("f", { f, g: "---\nname: g\n---\n" }), ["broken-flow spec.flow"]);
	});
});

describe("the call graph", () => {
	test("refuses a flow calling itself, and a cycle through other files, with its path", () => {
		const self = checkFlow("f", catalogueOf({ f: caller("f") }));
		assert.deepEqual(!self.ok && self.faults.map(({ code, at, message }) => [code, at, message]), [["call-cycle", "spec.flow", "`f` -> `f`: a flow that calls itself would never end"]]);
		const through = checkFlow("f", catalogueOf({ f: caller("g"), g: caller("h", "", "input", "g"), h: caller("f", "", "input", "h") }));
		assert.deepEqual(!through.ok && through.faults.map(({ message }) => message), ["`f` -> `g` -> `h` -> `f`: a flow that calls itself would never end"]);
	});

	test("refuses a cycle behind a `choice` that may never be taken, and a callee holding one of its own", () => {
		const g = flowText("  - id: gate\n    choice:\n      - when: \"false\"\n        do:\n          - id: back\n            flow: f\n            input: input\n    default: []", {}, undefined, "g");
		assert.deepEqual(refusedIn("f", { f: caller("g"), g }), ["call-cycle spec.flow"]);
		const h = caller("h", "", "input", "h");
		const result = checkFlow("f", catalogueOf({ f: caller("h"), h }));
		assert.deepEqual(!result.ok && result.faults.map(({ code, message }) => [code, message.split(":")[0]]), [["broken-flow", "`h` is flows/h.md, which is refused at `spec.flow`"]]);
	});
});

describe("what crosses the call", () => {
	test("`input` is held to the callee's `input:`, a typed value going to a text input", () => {
		const typedInput = looking("g", "", "input: { task: string }");
		assert.deepEqual(refusedIn("f", { f: caller("g"), g: typedInput }), ["flow-input-mismatch spec.input"]);
		const plan = flowText("  - id: plan\n    agent: planner\n    output: { task: string }\n  - id: spec\n    flow: g\n    input: plan.output", { plan: "Plan." });
		assert.ok(checkedIn("f", { f: plan, g: typedInput }), "the same type goes through");
		assert.ok(checkedIn("f", { f: plan, g: looking() }), "a typed value goes to a text input");
	});

	test("the output is the callee's last root node's, typed when it is", () => {
		const f = `${caller("g", GATE)}\n${PROSE}`;
		assert.ok(checkedIn("f", { f, g: looking("g", "{ ready: boolean }") }));
		assert.deepEqual(refusedIn("f", { f, g: looking() }), ["condition-type gate.choice[0].when"]);
	});

	test("the caller's scopes and ledgers stop at the call: a callee naming them is refused on its own", () => {
		const g = flowText("  - id: look\n    agent: reviewer\n    verdict: round", { look: "Look." }, undefined, "g");
		const f = flowText("  - id: round\n    loop: spec.ok\n    max: 2\n    ledger: round\n    do:\n      - id: spec\n        flow: g\n        input: input");
		assert.deepEqual(refusedIn("f", { f, g }), ["broken-flow round/spec.flow"]);
		assert.deepEqual(refusedIn("g", { f, g }), ["unknown-scope look.verdict"]);
	});
});

describe("the world, through the call", () => {
	const inBlock = (block: string) => flowText(`  - id: work\n${block}\n    do:\n      - id: fix\n        flow: g\n        input: item`);

	test("a callee's commit inside a `copies: true` block is refused, naming the caller's file and the call path", () => {
		const g = flowText("  - id: message\n    agent: scout\n  - id: commit\n    commit: message", { message: "Write." }, undefined, "g");
		const result = checkFlow("f", catalogueOf({ f: inBlock("    map: [a, b]\n    copies: true"), g }));
		assert.deepEqual(!result.ok && result.faults.map(({ code, file, at }) => [code, file, at]), [["commit-in-copies", "flows/f.md", "work/fix/commit.commit"]]);
		assert.ok(checkFlow("g", catalogueOf({ g })).ok, "the callee is valid on its own");
	});

	test("a callee that writes makes the branches calling it need copies", () => {
		const g = flowText("  - id: code\n    agent: coder", { code: "Code." }, undefined, "g");
		const flows = catalogueOf({ f: inBlock("    map: [a, b]\n    concurrency: 2"), g });
		const result = checkFlow("f", { ...flows, agents: [...AGENTS, agent("coder", ["read", "write"])] });
		assert.deepEqual(!result.ok && result.faults.map(({ code, message }) => [code, message]), [["copies-needed", "`concurrency: 2` runs items at once, and `work/fix/code` writes (`coder` has write): give each branch its own copy with `copies: true`, or `concurrency: 1`"]]);
	});

	test("the run stage reads the callee's checks and questions, at the call path, in the root's file", async () => {
		const g = flowText("  - id: tests\n    check: .pi/checks/none.sh\n  - id: q\n    ask: \"Go?\"", {}, undefined, "g");
		const flow = checkedIn("f", { f: caller("g"), g });
		const result = await checkRun(flow, { cwd: process.cwd(), ports: {}, somebodyThere: false });
		assert.deepEqual(!result.ok && result.faults.map(({ code, file, at }) => [code, file, at]), [
			["check-port-missing", "flows/f.md", "spec/tests.check"],
			["check-script-missing", "flows/f.md", "spec/tests.check"],
			["unattended-ask", "flows/f.md", "spec/q.ask"],
		]);
		const diff = await checkRun(checkedIn("f", { f: caller("g", "", "diff"), g: looking() }), { cwd: process.cwd(), ports: {}, somebodyThere: false });
		assert.deepEqual(!diff.ok && diff.faults.map(({ code, at }) => `${code} ${at}`), ["git-port-missing spec.input"], "a call handing in `diff` needs git");
	});
});
