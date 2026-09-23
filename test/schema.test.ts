/**
 * A flow's schemas, in both notations, read into one type model: the short
 * one as YAML hands it over, the long one as a closed JSON Schema subset.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { QUESTION, readSchema, showType, type ValueType } from "../src/flow/index.ts";

/** A schema as an author writes it after `output:`, read the way the flow file will be. */
function yaml(written: string): unknown {
	return parseFrontmatter<{ output: unknown }>(`---\noutput: ${written}\n---\n`).frontmatter.output;
}

function read(written: unknown): ValueType {
	const result = readSchema(written);
	assert.ok(result.ok, `expected a schema: ${JSON.stringify(!result.ok && result.problems)}`);
	return result.type;
}

function problems(written: unknown) {
	const result = readSchema(written);
	assert.ok(!result.ok, `expected ${JSON.stringify(written)} to be refused`);
	return result.problems.map(({ at, message }) => ({ at, message }));
}

describe("readSchema, the short notation", () => {
	test("reads what the shipped flows write, as YAML parses it", () => {
		assert.equal(showType(read(yaml("{ subtasks: [{ text: string }] }"))), "{ subtasks: [{ text: string }] }");
		assert.equal(showType(read(yaml("{ tasks: [{ worker: scout | reviewer, task: string }] }"))), "{ tasks: [{ worker: scout | reviewer, task: string }] }");
		assert.deepEqual(read(yaml("{ ready: boolean, question?: Question }")), {
			kind: "object",
			fields: { ready: { type: { kind: "boolean" }, optional: false }, question: { type: QUESTION, optional: true } },
		});
		assert.deepEqual(read(yaml("[number]")), { kind: "list", of: { kind: "number" } });
	});

	test("an enum is at least two values, none empty and none twice", () => {
		assert.deepEqual(read("a|b"), { kind: "enum", values: ["a", "b"] });
		assert.deepEqual(problems("a | | b"), [{ at: "", message: "an enum has at least two values, none empty" }]);
		assert.deepEqual(problems("a | b | a"), [{ at: "", message: "an enum names `a` twice" }]);
	});

	test("refuses what is not a schema, at the path where it is written, all at once", () => {
		assert.deepEqual(problems(yaml("{ plan: [{ text: strng }], count: 3, tags: [string, number] }")), [
			{ at: "plan[].text", message: "unknown type `strng`; the types are string, number, boolean, Question, or an enum written `a | b`" },
			{ at: "count", message: "3 is not a schema; write a type name, `a | b`, `[<schema>]` or `{ field: <schema> }`" },
			{ at: "tags", message: "a list is written `[<schema>]`, with exactly one schema inside" },
		]);
		assert.deepEqual(problems({}), [{ at: "", message: "an object has at least one field" }]);
		assert.deepEqual(problems(null), [{ at: "", message: "null is not a schema; write a type name, `a | b`, `[<schema>]` or `{ field: <schema> }`" }]);
	});

	test("a field name is one an address and a condition can read", () => {
		assert.deepEqual(problems({ "next-step": "string", "a.b?": "string", ok_1: "string" }), [
			{ at: "next-step", message: "`next-step`: a field name is letters, digits and `_`, since an address and a condition read it" },
			{ at: "a.b", message: "`a.b`: a field name is letters, digits and `_`, since an address and a condition read it" },
		]);
	});

	test("a short object cannot have a field named json-schema", () => {
		assert.deepEqual(problems({ "json-schema": { type: "string" }, other: "string" }), [
			{ at: "", message: "`json-schema` stands alone: a short object cannot have a field named so" },
		]);
	});
});

describe("readSchema, the long notation", () => {
	test("translates to the same model as the short one, and keeps the descriptions", () => {
		const long = read({
			"json-schema": {
				type: "object",
				description: "What is left to do.",
				properties: {
					subtasks: { type: "array", items: { type: "object", properties: { text: { type: "string", description: "One change, whole." } }, required: ["text"] } },
					verdict: { type: "string", enum: ["approved", "rejected"] },
					note: { type: "string" },
				},
				required: ["subtasks", "verdict"],
			},
		});
		assert.equal(showType(long), "{ subtasks: [{ text: string }], verdict: approved | rejected, note?: string }");
		assert.equal(long.description, "What is left to do.");
		const text = long.kind === "object" && long.fields.subtasks?.type;
		assert.equal(text && text.kind === "list" && text.of.kind === "object" && text.of.fields.text?.type.description, "One change, whole.");
	});

	test("nests inside a short object", () => {
		assert.equal(showType(read({ plan: { "json-schema": { type: "number" } }, done: "boolean" })), "{ plan: number, done: boolean }");
	});

	test("takes its six keywords and nothing else, each where it belongs", () => {
		const root = (schema: unknown) => problems({ "json-schema": schema });
		assert.deepEqual(root({ type: "string", minLength: 1, format: "uri" }), [
			{ at: "json-schema", message: "`minLength`, `format`: the keywords are type, properties, required, items, enum, description" },
		]);
		assert.deepEqual(root({ type: "integer" }), [{ at: "json-schema.type", message: "`type` is one of string, number, boolean, array, object" }]);
		assert.deepEqual(root({ type: "number", items: { type: "string" }, enum: ["a", "b"] }), [
			{ at: "json-schema", message: "`items` belongs to `type: array`; `enum` belongs to `type: string`" },
		]);
		assert.deepEqual(root({ type: "array" }), [{ at: "json-schema", message: "`type: array` needs `items`" }]);
		assert.deepEqual(root({ type: "object", properties: {} }), [{ at: "json-schema.properties", message: "`type: object` needs `properties`, with at least one" }]);
		assert.deepEqual(root({ type: "object", properties: { a: { type: "string" } }, required: ["b"] }), [
			{ at: "json-schema.required", message: "`b` is not among the properties" },
		]);
		assert.deepEqual(root({ type: "string", enum: ["only"] }), [{ at: "json-schema.enum", message: "`enum` has at least two values, none empty" }]);
		assert.deepEqual(root({ type: "string", description: 3 }), [{ at: "json-schema.description", message: "a description is a string" }]);
		assert.deepEqual(root({ type: "object", properties: { x: { type: "array", items: { type: "nope" } } } }), [
			{ at: "json-schema.properties.x.items.type", message: "`type` is one of string, number, boolean, array, object" },
		]);
	});
});
