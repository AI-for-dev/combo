/**
 * Claims: who gets the thing, who is told to ask, and what happens when a
 * holder disappears.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createClaims, heldList } from "../src/board/claims.ts";

describe("taking", () => {
	test("first to ask holds it, and the second is told who does", () => {
		const claims = createClaims();

		assert.deepEqual(claims.take("scout#1", "src/parser.ts"), { ok: true });

		const refused = claims.take("scout#2", "src/parser.ts");
		assert.equal(refused.ok, false);
		assert.equal(refused.ok ? undefined : refused.heldBy, "scout#1");
		assert.match(refused.ok ? "" : refused.error, /held by scout#1 - ask scout#1/);
	});

	test("taking what you already hold is granted: it is not contention", () => {
		const claims = createClaims();
		claims.take("scout#1", "src/parser.ts");

		assert.deepEqual(claims.take("scout#1", "src/parser.ts"), { ok: true });
		assert.equal(claims.open().length, 1);
	});

	test("a key nobody can name is refused, with the list", () => {
		// Measured on three members dividing one job: one file came back as
		// `console.ts`, `src/reporters/console.ts` and `I will handle
		// src/reporters/console.ts`. Free text would have granted all three.
		const claims = createClaims({ keys: ["console.ts", "tui.ts"] });

		const stray = claims.take("scout#1", "I will handle src/reporters/console.ts");
		assert.equal(stray.ok, false);
		assert.equal(stray.ok ? undefined : stray.heldBy, undefined, "nobody holds it: this is not contention");
		assert.match(stray.ok ? "" : stray.error, /nothing called.*to claim - there is console\.ts, tui\.ts/);

		assert.deepEqual(claims.take("scout#1", "console.ts"), { ok: true });
	});

	test("a bound on one member holds, where telling it to take one at a time did not", () => {
		// Measured on three members and six keys: with no bound one took
		// everything; with the rule in its prompt instead, four at once, the same
		// as with no rule at all.
		const claims = createClaims({ keys: ["a", "b"], maxPerMember: 1 });
		assert.deepEqual(claims.take("scout#1", "a"), { ok: true });

		const second = claims.take("scout#1", "b");
		assert.equal(second.ok, false);
		assert.equal(second.ok ? undefined : second.heldBy, undefined, "nobody holds it: the bound is the member's own");
		assert.match(second.ok ? "" : second.error, /already hold a.*release before taking another/);

		assert.deepEqual(claims.take("scout#2", "b"), { ok: true }, "and it binds one member, not the board");
	});

	test("taking what you already hold is still granted at the bound", () => {
		const claims = createClaims({ keys: ["a"], maxPerMember: 1 });
		claims.take("scout#1", "a");

		assert.deepEqual(claims.take("scout#1", "a"), { ok: true });
	});

	test("contention is reported before the bound: who has it is what a member can act on", () => {
		const claims = createClaims({ keys: ["a", "b"], maxPerMember: 1 });
		claims.take("scout#1", "a");
		claims.take("scout#2", "b");

		const both = claims.take("scout#2", "a");
		assert.equal(both.ok ? undefined : both.heldBy, "scout#1", "and not `you already hold b`");
	});

	test("releasing frees the bound as well as the thing", () => {
		const claims = createClaims({ keys: ["a", "b"], maxPerMember: 1 });
		claims.take("scout#1", "a");
		claims.release("scout#1", "a");

		assert.deepEqual(claims.take("scout#1", "b"), { ok: true });
	});

	test("a caller that cannot list the work takes any key", () => {
		const claims = createClaims();
		assert.deepEqual(claims.take("scout#1", "whatever it decides to call it"), { ok: true });
	});

	test("a key is trimmed, and an empty one names nothing", () => {
		const claims = createClaims();
		claims.take("scout#1", "  src/parser.ts  ");

		assert.equal(claims.owner("src/parser.ts"), "scout#1");
		assert.equal(claims.take("scout#2", "   ").ok, false);
	});
});

describe("releasing", () => {
	test("only the holder gives it up", () => {
		const claims = createClaims();
		claims.take("scout#1", "src/parser.ts");

		assert.equal(claims.release("scout#2", "src/parser.ts"), false, "and it is still held");
		assert.equal(claims.owner("src/parser.ts"), "scout#1");

		assert.equal(claims.release("scout#1", "src/parser.ts"), true);
		assert.equal(claims.owner("src/parser.ts"), undefined);
	});

	test("releasing what nobody holds changes nothing", () => {
		const claims = createClaims();
		assert.equal(claims.release("scout#1", "src/parser.ts"), false);
	});

	test("what it let go can be taken by somebody else", () => {
		const claims = createClaims();
		claims.take("scout#1", "src/parser.ts");
		claims.release("scout#1", "src/parser.ts");

		assert.deepEqual(claims.take("scout#2", "src/parser.ts"), { ok: true });
	});
});

describe("a member that is gone", () => {
	test("everything it held comes back, and the run can say what", () => {
		const claims = createClaims();
		claims.take("scout#1", "src/parser.ts");
		claims.take("scout#1", "src/lexer.ts");
		claims.take("scout#2", "src/tokens.ts");

		assert.deepEqual(claims.releaseAll("scout#1"), ["src/parser.ts", "src/lexer.ts"]);
		assert.deepEqual(
			claims.open().map((one) => one.key),
			["src/tokens.ts"],
			"and nobody else's are touched",
		);
	});

	test("a member that held nothing releases nothing", () => {
		const claims = createClaims();
		claims.take("scout#1", "src/parser.ts");

		assert.deepEqual(claims.releaseAll("scout#2"), []);
	});
});

describe("reading what is held", () => {
	test("open() is what is held now, in the order it was taken", () => {
		const claims = createClaims();
		claims.take("scout#2", "b");
		claims.take("scout#1", "a");
		claims.release("scout#2", "b");
		claims.take("scout#3", "c");

		assert.deepEqual(claims.open(), [
			{ key: "a", heldBy: "scout#1" },
			{ key: "c", heldBy: "scout#3" },
		]);
	});

	test("heldList says what a member needs to pick something else", () => {
		const claims = createClaims();
		claims.take("scout#1", "src/parser.ts");
		claims.take("scout#2", "src/lexer.ts");

		assert.equal(heldList(claims.open()), "src/parser.ts: scout#1\nsrc/lexer.ts: scout#2");
	});
});
