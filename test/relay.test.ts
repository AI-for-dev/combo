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
	beginStep,
	chainInput,
	chainLines,
	chainUsage,
	currentChain,
	entryOf,
	finishStep,
	forgetChain,
	framed,
	recordStep,
	startChain,
	STEP_ENTRY,
	stepAnswer,
	stepDir,
	stepFrom,
	stepId,
	type Relay,
	type RelayStep,
	type StepEntry,
} from "../extension/relay.ts";
import { emptyUsage } from "../src/usage.ts";

function chainOf(...steps: { name: string; output?: string; instruction?: string; turns?: number }[]): Relay {
	const relay = startChain("runs/2026-01-01_00-00-00");
	for (const step of steps) {
		recordStep(relay, {
			id: stepId(relay, step.name),
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

describe("the life of a step", () => {
	test("beginning one opens a chain when none is walked, in the folder it is given", () => {
		const begun = beginStep("coder", () => "runs/fresh");

		assert.equal(currentChain(), begun.relay);
		assert.equal(begun.relay.dir, "runs/fresh");
		assert.deepEqual({ id: begun.id, dir: begun.dir }, { id: "coder", dir: "runs/fresh/1-coder" });
	});

	test("beginning another continues the chain, under the next free id and the next folder", () => {
		chainOf({ name: "coder" });
		let opened = 0;
		const begun = beginStep("coder", () => (opened++, "runs/never"));

		assert.equal(opened, 0, "a chain already walked is not started again");
		assert.deepEqual({ id: begun.id, dir: begun.dir }, { id: "coder-2", dir: "runs/2026-01-01_00-00-00/2-coder-2" });
	});

	test("finishing one records it under the id it began with, and leaves its entry through the door in one call", () => {
		const entries: [string, StepEntry][] = [];
		const begun = beginStep("coder", () => "runs/x");

		const step = finishStep(
			begun,
			{ name: "coder", kind: "agent", instruction: "write it", output: "written", usage: { ...emptyUsage(), turns: 2 } },
			(customType, data) => void entries.push([customType, data]),
		);

		assert.deepEqual(currentChain()?.steps, [step]);
		assert.deepEqual({ id: step.id, dir: step.dir }, { id: "coder", dir: "runs/x/1-coder" }, "what beginStep named is what the record carries");
		assert.deepEqual(entries, [[STEP_ENTRY, entryOf(step)]]);
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

	test("recording a second step under an id the chain holds is a programming error", () => {
		const relay = chainOf({ name: "coder" });
		const again = { ...(relay.steps[0] as RelayStep) };
		assert.throws(() => recordStep(relay, again), /already in this chain/);
		assert.equal(relay.steps.length, 1);
	});
});

describe("where a step exports", () => {
	test("a numbered subfolder of the chain, named after the id, so the folder and the entry agree", () => {
		const relay = chainOf({ name: "coder" });
		assert.equal(stepDir(relay, "coder-2"), "runs/2026-01-01_00-00-00/2-coder-2");
		assert.equal(stepDir(startChain("runs/y"), "member#1"), "runs/y/1-member-1", "an id is made safe for a path");
	});
});

describe("the entry a step leaves", () => {
	test("says what the transcript shows, and carries less than the chain does", () => {
		const relay = chainOf({ name: "look" }, { name: "plan", turns: 2 });
		const plan = { ...(relay.steps[1] as RelayStep), from: "look" };

		assert.deepEqual(entryOf(plan), { id: "plan", kind: "agent", from: "look", output: "plan said something", turns: 2, dir: "runs/x/plan" });
		assert.ok(!("instruction" in entryOf(plan)), "what a step was asked stays in the chain, not in the session file");
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

	test("a later one gets the instruction under a heading, then what it carries under the step it came from", () => {
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
		assert.match(chainLines(undefined).join("\n"), /\/step <flow\|agent>/);
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

describe("framing a result for the conversation", () => {
	test("names what ran and what it was asked, and drops the ask when there was none", () => {
		assert.equal(framed("the `x` flow", "find it", "found"), "Result of the `x` flow, asked to: find it.\n\nfound");
		assert.equal(framed("the `x` flow", "  ", "found"), "Result of the `x` flow.\n\nfound");
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
