import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	answerInTheirLanguage,
	ANSWER_IN_THEIR_LANGUAGE,
	inTheLanguageOfTheWork,
	IN_THE_LANGUAGE_OF_THE_WORK,
} from "../src/language.ts";
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
		assert.match(ANSWER_IN_THEIR_LANGUAGE, /This prompt and the lines that frame each turn/);
	});

	test("it disowns the framing a combinator adds, not only the prompt", () => {
		// Measured on a swarm asked a French question: round one answered in
		// French, and every round after it in English - the board lines and the
		// round number arrive in the same message as the goal, and a rule that
		// disowned only the system prompt left them deciding the language.
		assert.match(ANSWER_IN_THEIR_LANGUAGE, /a round number, what is new, what is left to do/);
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

		for (const sentinel of [READY, "LGTM", "APPROVED"]) {
			assert.ok(!ANSWER_IN_THEIR_LANGUAGE.includes(sentinel), `${sentinel} is covered by the rule, not named by it`);
		}
	});
});

describe("inTheLanguageOfTheWork", () => {
	test("closes the turn, after whatever framed it", () => {
		const turn = inTheLanguageOfTheWork("Quel langage ?\n\nRound 2. Carry on.");

		assert.ok(turn.startsWith("Quel langage ?"), "the work stays first, and untouched");
		assert.ok(turn.endsWith(IN_THE_LANGUAGE_OF_THE_WORK), "and the rule is the last thing read before the answer");
	});

	test("it is one sentence, and names no language either", () => {
		// Repeated every turn, so it pays for every word. The exemptions stay in
		// the standing rule, which is in front of the model the whole time.
		assert.equal(IN_THE_LANGUAGE_OF_THE_WORK.split(". ").length, 1);
		assert.ok(!/\bFrench\b|\bEnglish\b/.test(IN_THE_LANGUAGE_OF_THE_WORK));
	});
});
