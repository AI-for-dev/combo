/**
 * The helpers that read what a model wrote.
 *
 * They were duplicated across five files before they lived here, so what is
 * pinned below is the behaviour every caller silently depended on: the
 * decorations a verdict survives, and the shapes the brace scanner walks past
 * without tripping.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { firstLine, jsonObjects, saysWord, scalar, truncate } from "../src/text.ts";

describe("truncate", () => {
	test("flattens whitespace and keeps the text under max", () => {
		assert.equal(truncate("  a\n  b  ", 10), "a b");
		assert.equal(truncate("abcdefghij", 5), "abcd…");
		assert.equal(truncate("abcde", 5), "abcde", "exactly max is not shortened");
	});
});

describe("firstLine", () => {
	test("the first line, or nothing", () => {
		assert.equal(firstLine("one\ntwo"), "one");
		assert.equal(firstLine(""), "");
	});
});

describe("scalar", () => {
	test("strings as they are, anything else as JSON, never undefined", () => {
		assert.equal(scalar("plain"), "plain");
		assert.equal(scalar({ a: 1 }), '{"a":1}');
		assert.equal(scalar(undefined), "");
	});
});

describe("saysWord", () => {
	test("the word alone on a line", () => {
		assert.equal(saysWord("looks fine\nLGTM", "LGTM"), true);
		assert.equal(saysWord("LGTM", "LGTM"), true);
	});

	test("survives the decoration a model adds anyway", () => {
		// Every one of these was seen from a real reviewer asked for one word.
		for (const line of ["**LGTM**", "## LGTM", "LGTM.", "`LGTM`", " lgtm "]) {
			assert.equal(saysWord(`some remarks\n${line}`, "LGTM"), true, line);
		}
	});

	test("a line with anything else on it does not count", () => {
		assert.equal(saysWord("not LGTM yet", "LGTM"), false);
		assert.equal(saysWord("LGTM once the test is fixed", "LGTM"), false);
		assert.equal(saysWord("", "LGTM"), false);
	});
});

describe("jsonObjects", () => {
	test("every top-level object, in order, whatever surrounds it", () => {
		const text = 'prose {"a":1} more\n```json\n[{"a":2},{"a":3}]\n```';
		assert.deepEqual([...jsonObjects(text)], [{ a: 1 }, { a: 2 }, { a: 3 }]);
	});

	test("a nested object is part of its parent, not a second result", () => {
		assert.deepEqual([...jsonObjects('{"a":{"b":1}}')], [{ a: { b: 1 } }]);
	});

	test("a brace inside a string does not end the object", () => {
		assert.deepEqual([...jsonObjects('{"a":"}"}')], [{ a: "}" }]);
		assert.deepEqual([...jsonObjects('{"a":"\\"}"}')], [{ a: '"}' }]);
	});

	test("what does not parse is skipped, and the scan carries on", () => {
		assert.deepEqual([...jsonObjects('{nope} {"a":1}')], [{ a: 1 }]);
		assert.deepEqual([...jsonObjects("no braces here")], []);
		assert.deepEqual([...jsonObjects('{"unclosed": 1')], [], "an unbalanced tail yields nothing");
	});
});
