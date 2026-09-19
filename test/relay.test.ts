/**
 * The relay: what a hand-walked chain keeps between two commands.
 *
 * Everything here is pure, and that is the point of the file existing apart
 * from the commands: the dataflow of a chain - what is carried, what a step is
 * actually asked, what `--from` resolves to - is asserted without a session, a
 * terminal or a spawn.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
	chainInput,
	chainLines,
	chainUsage,
	currentChain,
	forgetChain,
	recordStep,
	startChain,
	stepAnswer,
	stepFrom,
	stepId,
	type Relay,
	type RelayStep,
} from "../extension/relay.ts";
import { emptyUsage } from "../src/usage.ts";

function chainOf(...steps: { name: string; output?: string; instruction?: string; turns?: number }[]): Relay {
	const relay = startChain("runs/2026-01-01_00-00-00");
	for (const step of steps) {
		recordStep(relay, {
			name: step.name,
			kind: "agent",
			instruction: step.instruction ?? `do ${step.name}`,
			output: step.output ?? `${step.name} said something`,
			usage: { ...emptyUsage(), turns: step.turns ?? 1 },
			dir: `runs/x/${step.name}`,
		});
	}
	return relay;
}

beforeEach(forgetChain);

describe("the chain of this terminal", () => {
	test("there is none until a step starts one", () => {
		assert.equal(currentChain(), undefined);
		assert.equal(startChain("runs/x"), currentChain());
	});

	test("forgetting it leaves nothing behind - the next step starts a new folder", () => {
		chainOf({ name: "scout" });
		forgetChain();
		assert.equal(currentChain(), undefined);
	});
});

describe("step ids", () => {
	test("an agent run twice is `coder` then `coder-2`, so --from can name either", () => {
		const relay = chainOf({ name: "coder" });
		assert.equal(stepId(relay, "coder"), "coder-2");
		assert.equal(stepId(relay, "reviewer"), "reviewer");
	});

	test("the ids stay unique however many times the same agent runs", () => {
		const relay = chainOf({ name: "coder" }, { name: "coder" }, { name: "coder" });
		assert.deepEqual(relay.steps.map((step) => step.id), ["coder", "coder-2", "coder-3"]);
	});
});

describe("--from", () => {
	test("says nothing: the last step, which is what walking a chain means", () => {
		const relay = chainOf({ name: "scout" }, { name: "planner" });
		assert.equal(stepFrom(relay, undefined)?.id, "planner");
	});

	test("`none` breaks the carry, for a step that starts from scratch", () => {
		const relay = chainOf({ name: "scout" });
		assert.equal(stepFrom(relay, "none"), undefined);
	});

	test("reaching back by id is the reason the whole chain is kept", () => {
		const relay = chainOf({ name: "scout" }, { name: "planner" }, { name: "coder" });
		assert.equal(stepFrom(relay, "planner")?.id, "planner");
	});

	test("a name nothing answers to lists what the chain does hold", () => {
		const relay = chainOf({ name: "scout" }, { name: "planner" });
		assert.throws(() => stepFrom(relay, "plan"), /no step called `plan`.*scout, planner/s);
	});

	test("the first step of a chain carries nothing, and that is not an error", () => {
		assert.equal(stepFrom(undefined, undefined), undefined);
		assert.throws(() => stepFrom(undefined, "scout"), /nothing has run yet/);
	});
});

describe("what a step is asked", () => {
	test("the first one is passed through verbatim, like /run passes its request", () => {
		assert.equal(chainInput("  find the parser  "), "find the parser");
	});

	test("a later one gets the pipeline's own sections, so the two can be compared", () => {
		const [previous] = chainOf({ name: "scout", output: "it is in src/parse.ts" }).steps;
		const input = chainInput("plan the change", previous);

		assert.match(input, /## Request\n\nplan the change/);
		assert.match(input, /## Output of step `scout`\n\nit is in src\/parse\.ts/);
	});

	test("an empty instruction leaves the carried output as the whole task", () => {
		const [previous] = chainOf({ name: "coder", output: "the diff" }).steps;
		const input = chainInput("", previous);

		assert.doesNotMatch(input, /## Request/);
		assert.match(input, /## Output of step `coder`\n\nthe diff/);
	});
});

describe("what the chain adds up to", () => {
	test("the turns of every step, summed", () => {
		assert.equal(chainUsage(chainOf({ name: "a", turns: 2 }, { name: "b", turns: 3 })).turns, 5);
	});

	test("nothing yet says how to start one, which is the question behind the command", () => {
		assert.match(chainLines(undefined).join("\n"), /\/step <agent\|pipeline>/);
	});

	test("one line per step, with what it carried and what it cost", () => {
		const relay = chainOf({ name: "scout", turns: 2 }, { name: "planner", turns: 1 });
		relay.steps[1]!.from = "scout";
		const lines = chainLines(relay);

		assert.match(lines[0] ?? "", /^1\. scout /);
		assert.match(lines[1] ?? "", /←scout/);
		assert.match(lines.at(-1) ?? "", /2 steps, 3 turns - exported to runs\//);
	});
});

describe("sharing a step", () => {
	test("names the step and what it was asked: a user slot needs an attribution", () => {
		const step = chainOf({ name: "planner", instruction: "three steps at most", output: "1. …" }).steps[0] as RelayStep;
		const shared = stepAnswer(step);

		assert.match(shared, /^Result of the `planner` step of the chain, asked to: three steps at most\./);
		assert.match(shared, /1\. …/);
	});

	test("a step that was only handed an output still says which step it is", () => {
		const step = chainOf({ name: "reviewer", instruction: "", output: "LGTM" }).steps[0] as RelayStep;
		assert.match(stepAnswer(step), /^Result of the `reviewer` step of the chain\.\n\nLGTM$/);
	});
});
