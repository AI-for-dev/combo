import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { answerInTheirLanguage, ANSWER_IN_THEIR_LANGUAGE } from "../src/language.ts";
import { APPROVAL } from "../src/workflows/pair.ts";
import { AUDIT_APPROVAL } from "../src/workflows/audit.ts";
import { READY } from "../src/workflows/interview.ts";

describe("answerInTheirLanguage", () => {
	test("is appended, never substituted for the definition", () => {
		const prompt = answerInTheirLanguage("You locate code.");

		assert.ok(prompt.startsWith("You locate code.\n\n"), "the agent's own prompt comes first, untouched");
		assert.ok(prompt.endsWith(ANSWER_IN_THEIR_LANGUAGE));
	});

	test("it points at the work, not at the instructions around it", () => {
		// Measured: "the language of the task" loses a French goal wrapped in
		// English scaffolding, which is every review, plan and audit. The rule has
		// to name the material and disown the prompt carrying it.
		assert.match(ANSWER_IN_THEIR_LANGUAGE, /^Answer in the language of the work you are given/);
		assert.match(ANSWER_IN_THEIR_LANGUAGE, /These instructions are always written in English/);
	});

	test("it names no language of its own", () => {
		// Also measured: a wording that said "if the work is in French, answer in
		// French" made an English question come back in French. An example in a
		// standing instruction is read as the target, so there is none.
		assert.ok(!/\bFrench\b|\bEnglish-speaking\b/.test(ANSWER_IN_THEIR_LANGUAGE));
		assert.match(ANSWER_IN_THEIR_LANGUAGE, /neither does any example in them/);
	});

	test("it exempts by shape rather than by listing every sentinel", () => {
		// A model told to write French writes PRÊT for READY and RAS for LGTM,
		// which is a loop that never converges and a review nobody can read. The
		// library cannot enumerate the words - a user's own workflow has its own -
		// so the exemption has to cover a word that was asked for exactly.
		assert.match(ANSWER_IN_THEIR_LANGUAGE, /told to answer with is not translated/);
		assert.match(ANSWER_IN_THEIR_LANGUAGE, /JSON key/);

		for (const sentinel of [READY, APPROVAL, AUDIT_APPROVAL]) {
			assert.ok(!ANSWER_IN_THEIR_LANGUAGE.includes(sentinel), `${sentinel} is covered by the rule, not named by it`);
		}
	});
});
