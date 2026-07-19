/**
 * The interview, with a scripted user.
 *
 * The point of the `AskUser` port is exactly this: a conversation with a human
 * can be replayed offline, deterministically, with no terminal anywhere near it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scriptedAsk } from "../src/ask.ts";
import { interview, parseQuestion, READY } from "../src/workflows/interview.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const interviewer = testAgent("interviewer", { description: "Asks one question at a time" });

const question = (text: string, ...labels: string[]) =>
	JSON.stringify({ header: "scope", question: text, options: labels.map((label) => ({ label, description: `pick ${label}` })) });

/** Replays `outputs` turn by turn; anything after them is the brief. */
const agentSays = (...outputs: string[]) => {
	let turn = 0;
	return fakeSpawn(() => ({ output: outputs[turn++] ?? "THE BRIEF" }));
};

describe("interview", () => {
	test("asks one question at a time and ends with a brief", async () => {
		const fake = agentSays(question("Which storage?", "sqlite", "postgres"), question("Which runtime?", "node", "bun"), READY);
		const ask = scriptedAsk(["sqlite", "node"]);

		const result = await interview({ agent: interviewer, input: "build me a cache", ask, spawn: fake.spawn });

		assert.equal(ask.asked.length, 2, "one question at a time, and no more than the agent asked for");
		assert.deepEqual(
			result.answers.map((answer) => answer.answer),
			["sqlite", "node"],
		);
		assert.equal(result.brief, "THE BRIEF");
		assert.equal(result.ok, true);
		assert.equal(result.submitted, false);
	});

	test("one subagent for the whole conversation: an interviewer that forgets is useless", async () => {
		const fake = agentSays(question("a?", "x"), question("b?", "y"), READY);
		await interview({ agent: interviewer, input: "x", ask: scriptedAsk(["x", "y"]), spawn: fake.spawn });

		assert.equal(fake.spawned.length, 1);
		assert.equal(fake.spawned[0]?.options.lifetime, "workflow", "an interview is a conversation, not a series of strangers");
	});

	test("the user can submit at any point, and what they already said still counts", async () => {
		const fake = agentSays(question("a?", "x"), question("b?", "y"));
		const ask = scriptedAsk(["x"]); // runs out: the second question is submitted through

		const result = await interview({ agent: interviewer, input: "x", ask, spawn: fake.spawn });

		assert.equal(result.submitted, true);
		assert.equal(result.answers.length, 1);
		assert.equal(result.brief, "THE BRIEF", "a brief is still written from what was answered");
		assert.match(fake.asks.at(-1)?.task ?? "", /a\?/, "the brief prompt carries what was answered");
	});

	test("READY ends the questions immediately", async () => {
		const fake = agentSays(READY);
		const ask = scriptedAsk(["never used"]);

		const result = await interview({ agent: interviewer, input: "x", ask, spawn: fake.spawn });

		assert.equal(ask.asked.length, 0);
		assert.equal(result.answers.length, 0);
		assert.equal(result.ok, true);
	});

	test("READY is recognised through the decoration a model adds", async () => {
		const fake = agentSays("**READY**");
		const result = await interview({ agent: interviewer, input: "x", ask: scriptedAsk([]), spawn: fake.spawn });
		assert.equal(result.ok, true);
		assert.equal(result.answers.length, 0);
	});

	test("maxQuestions caps the interrogation", async () => {
		const fake = agentSays(question("a?", "x"), question("b?", "y"));
		const ask = scriptedAsk(["x", "y", "z", "w"]);

		const result = await interview({ agent: interviewer, input: "x", ask, maxQuestions: 2, spawn: fake.spawn });

		assert.equal(ask.asked.length, 2);
		assert.equal(result.answers.length, 2);
		assert.equal(result.brief, "THE BRIEF");
	});

	test("prose instead of a question is not an error: the agent has said its piece", async () => {
		const fake = agentSays("I think we should use sqlite, but it depends.");
		const ask = scriptedAsk(["unused"]);

		const result = await interview({ agent: interviewer, input: "x", ask, spawn: fake.spawn });

		assert.equal(ask.asked.length, 0, "a malformed card must never reach the user");
		assert.equal(result.ok, true);
		assert.equal(result.brief, "THE BRIEF");
	});

	test("a failing agent is a failed interview, with no brief invented", async () => {
		const fake = fakeSpawn(() => ({ ok: false, error: "provider exploded" }));
		const result = await interview({ agent: interviewer, input: "x", ask: scriptedAsk([]), spawn: fake.spawn });

		assert.equal(result.ok, false);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.brief, "");
	});

	test("cancellation: nothing is spawned, nobody is asked anything", async () => {
		const fake = agentSays(question("a?", "x"));
		const ask = scriptedAsk(["x"]);

		const result = await interview({ agent: interviewer, input: "x", ask, signal: AbortSignal.abort(), spawn: fake.spawn });

		assert.equal(fake.spawned.length, 0);
		assert.equal(ask.asked.length, 0);
		assert.equal(result.ok, false);
	});

	test("the subagent is closed whatever happens", async () => {
		const fake = agentSays(question("a?", "x"), READY);
		await interview({ agent: interviewer, input: "x", ask: scriptedAsk(["x"]), spawn: fake.spawn });

		assert.deepEqual(
			fake.closed,
			fake.spawned.map((entry) => entry.id),
		);
	});

	test("usage covers every turn, the brief included", async () => {
		const fake = fakeSpawn((task) => ({
			output: task.includes("specification") ? "THE BRIEF" : READY,
			usage: { input: 100 },
		}));
		const result = await interview({ agent: interviewer, input: "x", ask: scriptedAsk([]), spawn: fake.spawn });

		assert.equal(result.usage.input, 200);
		assert.equal(result.usage.turns, 2);
	});
});

describe("parseQuestion", () => {
	test("reads the JSON object the agent was asked for", () => {
		const parsed = parseQuestion(question("Which storage?", "sqlite", "postgres"));
		assert.equal(parsed?.question, "Which storage?");
		assert.equal(parsed?.header, "scope");
		assert.deepEqual(
			parsed?.options.map((choice) => choice.label),
			["sqlite", "postgres"],
		);
	});

	test("reads it through a fence and through prose", () => {
		const fenced = '```json\n{"question":"Which one?","options":["a","b"]}\n```';
		assert.equal(parseQuestion(fenced)?.question, "Which one?");
		assert.equal(parseQuestion(`Sure!\n${fenced}\nHope that helps.`)?.question, "Which one?");
	});

	test("plain string options are options too", () => {
		const parsed = parseQuestion('{"question":"Which one?","options":["a","b"]}');
		assert.deepEqual(parsed?.options, [{ label: "a" }, { label: "b" }]);
	});

	test("a question with no usable option is no question", () => {
		assert.equal(parseQuestion('{"question":"Which one?","options":[]}'), undefined);
		assert.equal(parseQuestion('{"question":"Which one?"}'), undefined);
		assert.equal(parseQuestion('{"options":["a","b"]}'), undefined);
	});

	test("skips objects that are not questions and keeps looking", () => {
		const noisy = '{"thinking":"hmm"}\n{"question":"Which one?","options":["a"]}';
		assert.equal(parseQuestion(noisy)?.question, "Which one?");
	});

	test("prose alone is undefined, not a blank card", () => {
		assert.equal(parseQuestion("Tell me more about what you want."), undefined);
	});

	test("a brace inside a label does not end the object", () => {
		const tricky = '{"question":"Which template?","options":[{"label":"{name}.ts"}]}';
		assert.equal(parseQuestion(tricky)?.options[0]?.label, "{name}.ts");
	});
});
