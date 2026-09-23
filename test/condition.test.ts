/**
 * A flow's conditions: parsed as CEL parses them, refused before the run when
 * they could only ever mislead it, and never a silent `false` when a value is
 * missing.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compileCondition, evaluateCondition, type Condition, type Readable, type ValueType } from "../src/flow/index.ts";

const boolean: ValueType = { kind: "boolean" };
const string: ValueType = { kind: "string" };
const number: ValueType = { kind: "number" };
const verdict: ValueType = { kind: "enum", values: ["approved", "rejected"] };

function object(fields: Record<string, ValueType>, optional: string[] = []): ValueType {
	return { kind: "object", fields: Object.fromEntries(Object.entries(fields).map(([k, type]) => [k, { type, optional: optional.includes(k) }])) };
}

/** A node as a condition reads it: `ok`, then an `output` that a failure leaves absent. */
function node(output: ValueType): ValueType {
	return object({ ok: boolean, output }, ["output"]);
}

/** What the shipped flows' conditions read. */
const readable: Readable = {
	tests: node(object({ passed: boolean, report: string })),
	audit: node(object({ approved: boolean, remarks: string })),
	review: node(object({ approved: boolean, status: verdict })),
	deliver: object({ ledger: { kind: "list", of: object({ id: string, text: string }) } }),
	ask_next: node(object({ ready: boolean })),
	gate: node(object({ case: string, output: object({ answered: boolean }) }, ["output"])),
	plan: node(object({ subtasks: { kind: "list", of: object({ worker: { kind: "enum", values: ["scout", "reviewer"] }, done: boolean }) } })),
	input: string,
};

function compiled(source: string, env: Readable = readable): Condition {
	const result = compileCondition(source, env);
	assert.ok(result.ok, `expected ${source} to compile: ${JSON.stringify(!result.ok && result.problems)}`);
	return result.condition;
}

function refused(source: string, env: Readable = readable) {
	const result = compileCondition(source, env);
	assert.ok(!result.ok, `expected ${source} to be refused`);
	return result.problems;
}

function evaluate(source: string, values: Record<string, unknown>) {
	return evaluateCondition(compiled(source), values);
}

describe("compileCondition", () => {
	test("accepts the conditions the shipped flows are written with", () => {
		for (const source of [
			"tests.output.passed && audit.output.approved",
			"size(deliver.ledger) == 0",
			"review.output.approved",
			"ask_next.output.ready || !gate.output.output.answered",
			"audit.ok && audit.output.approved",
			"has(gate.output.output) && gate.output.output.answered",
			'plan.output.subtasks.all(t, t.done || t.worker == "scout")',
			'review.output.status in ["approved"]',
			"size(input) > -1",
		]) {
			compiled(source);
		}
	});

	test("a dash in a name is subtraction to CEL, so it is refused where it is written, with the name to use", () => {
		const [problem] = refused("ask-next.output.ready");
		assert.equal(problem?.code, "condition-syntax");
		assert.match(problem?.message ?? "", /`ask-next`.*`ask_next`/);
	});

	test("what CEL has and the subset leaves out is refused with the reason", () => {
		const cases: [string, RegExp][] = [
			["size(deliver.ledger) + 1 == 2", /no arithmetic/],
			["size(deliver.ledger) - 1 == 2", /no arithmetic/],
			["review.output.approved ? true : false", /no ternary/],
			['input.startsWith("a")', /macros are `all` and `exists`/],
			["matches(input)", /functions are `size` and `has`/],
			["deliver.ledger.size() == 0", /size is written `size\(x\)`/],
			["null == input", /reserves/],
			["tests.output.passed = true", /equality is `==`/],
			["tests.output.passed & true", /doubled/],
			['input == "open', /not closed/],
			["has(input)", /takes a field/],
			["tests.output.passed tests", /unexpected `tests` at 21/],
			["(tests.output.passed", /expected `\)`, found the end/],
		];
		for (const [source, message] of cases) {
			const problems = refused(source);
			assert.deepEqual(problems.map((p) => p.code), ["condition-syntax"], source);
			assert.match(problems[0]?.message ?? "", message, source);
		}
	});

	test("an address that is not readable names what is, and a field that does not exist names the fields", () => {
		const [unknown] = refused("test.output.passed");
		assert.equal(unknown?.code, "condition-unknown-address");
		assert.match(unknown?.message ?? "", /`test` is not readable here; what is: tests, audit/);
		const [field] = refused("tests.output.pased");
		assert.equal(field?.code, "condition-unknown-address");
		assert.match(field?.message ?? "", /`tests.output` has no field `pased`; its fields: passed, report/);
	});

	test("an enum is strict: a literal outside it is refused, in an equality and in a list", () => {
		for (const source of ['review.output.status == "aproved"', '"aproved" != review.output.status', 'review.output.status in ["approved", "aproved"]']) {
			const problems = refused(source);
			assert.deepEqual(problems.map((p) => p.code), ["condition-enum-value"], source);
			assert.match(problems[0]?.message ?? "", /"aproved" is not one of approved \| rejected/);
		}
		const [disjoint] = refused("plan.output.subtasks.exists(t, t.worker == review.output.status)");
		assert.equal(disjoint?.code, "condition-type");
		assert.match(disjoint?.message ?? "", /\(scout \| reviewer\) and .* \(approved \| rejected\) share no value/);
		compiled("plan.output.subtasks.exists(t, t.worker == input)");
	});

	test("sides that could never compare, and operators on the wrong type, are refused", () => {
		const cases: [string, RegExp][] = [
			["tests.output.passed == 1", /is a boolean and `1` a number/],
			["tests.output.report < 1", /orders two numbers or two strings/],
			["review.output.status < \"b\"", /orders two numbers or two strings/],
			["size(tests.output.passed) == 0", /counts a list or a string/],
			["tests.output.report.all(x, true)", /walks a list/],
			["tests.output.report.passed", /is a string, which has no field `passed`/],
			["tests.output == tests.output", /only a string, a number, a boolean or an enum compares/],
			["!tests.output.report", /is a string, where a boolean is needed/],
			["input in input", /looks in a list/],
			["size([]) == 0", /empty list/],
			["[1, \"a\"] == [1]", /never compare equal/],
		];
		for (const [source, message] of cases) {
			const problems = refused(source);
			assert.deepEqual(problems.map((p) => p.code), ["condition-type"], source);
			assert.match(problems[0]?.message ?? "", message, source);
		}
	});

	test("a condition is a boolean", () => {
		const [problem] = refused("size(deliver.ledger)");
		assert.equal(problem?.code, "condition-type");
		assert.match(problem?.message ?? "", /a condition is a boolean, and `size\(deliver.ledger\)` is a number/);
	});

	test("every fault is reported, and none that only follows from another", () => {
		const problems = refused('tests.output.pased && review.output.status == "aproved" && !tests.output.pased');
		assert.deepEqual(problems.map((p) => p.code), ["condition-unknown-address", "condition-enum-value", "condition-unknown-address"]);
		assert.equal(refused("size(nothing.at.all) == 0 || nothing").length, 2, "one per unknown name, nothing about what they would have been compared with");
	});

	test("a macro's variable is readable in its body only", () => {
		compiled("plan.output.subtasks.exists(t, t.done)");
		const [problem] = refused("plan.output.subtasks.exists(t, t.done) && t.done");
		assert.match(problem?.message ?? "", /`t` is not readable here/);
	});
});

describe("evaluateCondition", () => {
	const passed = { tests: { ok: true, output: { passed: true, report: "" } } };
	const failedAudit = { audit: { ok: false } };

	test("reads the values an address names", () => {
		assert.deepEqual(evaluate("tests.output.passed && audit.output.approved", { ...passed, audit: { ok: true, output: { approved: false, remarks: "" } } }), { ok: true, value: false });
		assert.deepEqual(evaluate("size(deliver.ledger) == 0", { deliver: { ledger: [] } }), { ok: true, value: true });
		assert.deepEqual(evaluate('review.output.status in ["approved"]', { review: { ok: true, output: { approved: true, status: "approved" } } }), { ok: true, value: true });
	});

	test("a missing value is a failure naming it, never false", () => {
		const result = evaluate("audit.output.approved", failedAudit);
		assert.deepEqual(result, { ok: false, message: "`audit.output` is absent" });
		assert.deepEqual(evaluate("!gate.output.output.answered", { gate: { ok: true, output: { case: "default" } } }), { ok: false, message: "`gate.output.output` is absent" });
	});

	test("a side that decides wins over a side that fails, whichever comes first, as in CEL", () => {
		assert.deepEqual(evaluate("audit.ok && audit.output.approved", failedAudit), { ok: true, value: false });
		assert.deepEqual(evaluate("audit.output.approved && audit.ok", failedAudit), { ok: true, value: false });
		assert.deepEqual(evaluate("!audit.ok || audit.output.approved", failedAudit), { ok: true, value: true });
		assert.equal(evaluate("audit.output.approved || audit.ok", failedAudit).ok, false, "nothing decides, so the failure stands");
	});

	test("has() guards an optional field", () => {
		const source = "has(gate.output.output) && gate.output.output.answered";
		assert.deepEqual(evaluate(source, { gate: { ok: true, output: { case: "default" } } }), { ok: true, value: false });
		assert.deepEqual(evaluate(source, { gate: { ok: true, output: { case: "0", output: { answered: true } } } }), { ok: true, value: true });
	});

	test("all and exists follow the same rule over their items", () => {
		const subtasks = (items: unknown[]) => ({ plan: { ok: true, output: { subtasks: items } } });
		const all = "plan.output.subtasks.all(t, t.done)";
		const exists = "plan.output.subtasks.exists(t, t.done)";
		assert.deepEqual(evaluate(all, subtasks([{ done: true }, { done: false }])), { ok: true, value: false });
		assert.deepEqual(evaluate(all, subtasks([])), { ok: true, value: true });
		assert.deepEqual(evaluate(all, subtasks([{}, { done: false }])), { ok: true, value: false }, "a false item decides past a failing one");
		assert.equal(evaluate(all, subtasks([{}, { done: true }])).ok, false);
		assert.deepEqual(evaluate(exists, subtasks([{}, { done: true }])), { ok: true, value: true });
		assert.deepEqual(evaluate(exists, subtasks([])), { ok: true, value: false });
	});

	test("parses with CEL's precedence", () => {
		const env: Readable = { a: boolean, b: boolean, n: number };
		const run = (source: string, values: Record<string, unknown>) => evaluateCondition(compiled(source, env), values);
		assert.deepEqual(run("!a == b", { a: true, b: false }), { ok: true, value: true }, "(!a) == b");
		assert.deepEqual(run("a || b && false", { a: true, b: true }), { ok: true, value: true }, "a || (b && false)");
		assert.deepEqual(run("n >= -2.5 && n < 1e3", { n: -2 }), { ok: true, value: true });
	});

	test("size counts characters, not bytes", () => {
		assert.deepEqual(evaluate("size(input) == 2", { input: "é😀" }), { ok: true, value: true });
	});

	test("a value off its declared type fails rather than guessing", () => {
		assert.deepEqual(evaluate("tests.output.passed", { tests: { ok: true, output: { passed: "yes" } } }), { ok: false, message: "`tests.output.passed` gave \"yes\", not a boolean" });
		assert.deepEqual(evaluate("size(deliver.ledger) == 0", { deliver: { ledger: 3 } }), { ok: false, message: "`deliver.ledger` is not a list or a string" });
	});
});
