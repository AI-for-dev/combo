/**
 * The delegation tool, offline.
 *
 * Two things are pinned here and nowhere else: what an agent is allowed to
 * delegate to, and how deep it may go. Both are permission boundaries in code,
 * so both are tested by driving the tool rather than by reading a prompt.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { declaresDelegate, delegateTool, MAX_DEPTH, SUBAGENT_TOOL } from "../src/delegate.ts";
import { callTool } from "./fixtures/call-tool.ts";
import { fakeSpawn, offeredTools, testAgent } from "./fixtures/fake-subagent.ts";

const scout = testAgent("scout", { description: "Reads code" });
const splitter = testAgent("splitter", { description: "Splits reading", tools: ["read", SUBAGENT_TOOL] });
const roster = [scout, splitter];

describe("declaresDelegate", () => {
	test("only a definition that names the tool asks for children", () => {
		assert.equal(declaresDelegate(["read", SUBAGENT_TOOL]), true);
		assert.equal(declaresDelegate(["read"]), false);
		assert.equal(declaresDelegate(undefined), false, "the read-only default names nothing");
	});
});

describe("delegateTool", () => {
	test("runs the named agent over the tasks, and labels every answer", async () => {
		const fake = fakeSpawn((task) => ({ output: `saw ${task}` }));
		const tool = delegateTool({ agents: roster, spawn: fake.spawn });

		const answer = await callTool(tool, { agent: "scout", tasks: ["find A", "find B"] });

		assert.notEqual(answer.isError, true);
		assert.match(answer.content[0]?.text ?? "", /## 1\. scout\n\nsaw find A/);
		assert.match(answer.content[0]?.text ?? "", /## 2\. scout\n\nsaw find B/);
		assert.equal(fake.spawned.length, 2, "one branch per task");
	});

	test("a branch that failed is reported, not dropped", async () => {
		const fake = fakeSpawn((task) => (task === "find B" ? { ok: false, error: "provider exploded" } : {}));
		const tool = delegateTool({ agents: roster, spawn: fake.spawn });

		const answer = await callTool(tool, { agent: "scout", tasks: ["find A", "find B"] });

		assert.match(answer.content[0]?.text ?? "", /## 2\. scout \(failed\)\n\nprovider exploded/);
	});

	test("a name nobody on the roster answers to is refused, and the roster is named", async () => {
		const fake = fakeSpawn();
		const tool = delegateTool({ agents: roster, spawn: fake.spawn });

		const answer = await callTool(tool, { agent: "ghost", tasks: ["anything"] });

		assert.equal(answer.isError, true);
		assert.match(answer.content[0]?.text ?? "", /No subagent named "ghost"\. Available: scout, splitter\./);
		assert.equal(fake.spawned.length, 0, "guessing who was meant is how the wrong agent runs");
	});

	test("no tasks is refused rather than paid for", async () => {
		const fake = fakeSpawn();
		const tool = delegateTool({ agents: roster, spawn: fake.spawn });

		const answer = await callTool(tool, { agent: "scout", tasks: ["  ", ""] });

		assert.equal(answer.isError, true);
		assert.equal(fake.spawned.length, 0);
	});
});

describe("how deep it goes", () => {
	test("the default bound is the session, a child and a grandchild", () => {
		assert.equal(MAX_DEPTH, 2);
	});

	test("a child that declares the tool is handed it, one level deeper", async () => {
		const fake = fakeSpawn();
		const tool = delegateTool({ agents: roster, spawn: fake.spawn });

		await callTool(tool, { agent: "splitter", tasks: ["split this"] });

		const offered = offeredTools(fake.spawned[0]?.options ?? {});
		assert.equal(offered.length, 1, "it asked for children of its own");

		// That tool is at the bound, so calling it refuses rather than spawning.
		const deeper = await callTool(offered?.[0] as never, { agent: "scout", tasks: ["go deeper"] });
		assert.equal(deeper.isError, true);
		assert.match(deeper.content[0]?.text ?? "", /2 level\(s\) deep and 2 is the limit/);
		assert.equal(fake.spawned.length, 1, "and nothing was spawned under it");
	});

	test("a child that declares nothing is offered nothing", async () => {
		const fake = fakeSpawn();
		const tool = delegateTool({ agents: roster, spawn: fake.spawn });

		await callTool(tool, { agent: "scout", tasks: ["just read"] });

		assert.deepEqual(offeredTools(fake.spawned[0]?.options ?? {}), []);
	});

	test("the bound is the caller's, and one level means no delegation at all", async () => {
		const fake = fakeSpawn();
		const tool = delegateTool({ agents: roster, spawn: fake.spawn, maxDepth: 1 });

		const answer = await callTool(tool, { agent: "scout", tasks: ["anything"] });

		assert.equal(answer.isError, true);
		assert.match(answer.content[0]?.text ?? "", /1 level\(s\) deep and 1 is the limit/);
		assert.equal(fake.spawned.length, 0);
	});

	test("a deeper bound lets the grandchild spawn", async () => {
		const fake = fakeSpawn();
		const tool = delegateTool({ agents: roster, spawn: fake.spawn, maxDepth: 3 });

		await callTool(tool, { agent: "splitter", tasks: ["split this"] });
		const offered = offeredTools(fake.spawned[0]?.options ?? {})[0];
		await callTool(offered as never, { agent: "scout", tasks: ["go deeper"] });

		assert.deepEqual(
			fake.spawned.map((one) => one.agent),
			["splitter", "scout"],
		);
	});
});

describe("what it costs, and whose cost it is", () => {
	test("every child hangs under the subagent that called the tool", async () => {
		const fake = fakeSpawn();
		const tool = delegateTool({ agents: roster, spawn: fake.spawn, parentId: "explorer#1" });

		await callTool(tool, { agent: "scout", tasks: ["read A", "read B"] });

		assert.deepEqual(
			fake.spawned.map((one) => one.options.parentId),
			["explorer#1", "explorer#1"],
		);
	});

	test("a grandchild hangs under the child, not under the holder", async () => {
		const fake = fakeSpawn();
		const tool = delegateTool({ agents: roster, spawn: fake.spawn, maxDepth: 3, parentId: "explorer#1" });

		await callTool(tool, { agent: "splitter", tasks: ["split this"] });
		// Built from the child's own id, as `spawn` minted it, and not from
		// anything its parent could have known.
		const child = fake.spawned[0];
		await callTool(offeredTools(child?.options ?? {}, child?.id)[0] as never, { agent: "scout", tasks: ["deeper"] });

		assert.deepEqual(
			fake.spawned.map((one) => [one.id, one.options.parentId]),
			[
				["splitter#1", "explorer#1"],
				["scout#2", "splitter#1"],
			],
		);
	});

	test("with nobody to hang under, the children are still spawned and still measured", async () => {
		// A caller building the tool by hand and not passing an id gets a flat
		// measurement, never a lost one.
		const fake = fakeSpawn();
		const tool = delegateTool({ agents: roster, spawn: fake.spawn });

		await callTool(tool, { agent: "scout", tasks: ["read A"] });

		assert.equal(fake.spawned.length, 1);
		assert.equal(fake.spawned[0]?.options.parentId, undefined);
	});
});

describe("how wide it goes", () => {
	test("the delegator's own number decides, not the caller's", async () => {
		const wide = testAgent("wide", { tools: ["read", SUBAGENT_TOOL], concurrency: 2 });
		const fake = fakeSpawn(async () => ({ delayMs: 5 }));
		const tool = delegateTool({ agents: [scout, wide], holder: wide, spawn: fake.spawn, concurrency: 4 });

		await callTool(tool, { agent: "scout", tasks: ["a", "b", "c", "d"] });

		assert.equal(fake.maxConcurrent, 2, "its file says two at a time, and the call site said four");
	});

	test("without one on the agent, the caller's stands", async () => {
		const plain = testAgent("plain", { tools: ["read", SUBAGENT_TOOL] });
		const fake = fakeSpawn(async () => ({ delayMs: 5 }));
		const tool = delegateTool({ agents: [scout, plain], holder: plain, spawn: fake.spawn, concurrency: 2 });

		await callTool(tool, { agent: "scout", tasks: ["a", "b", "c", "d"] });

		assert.equal(fake.maxConcurrent, 2);
	});

	test("a child that delegates in turn is read from its own file", async () => {
		const narrow = testAgent("narrow", { tools: ["read", SUBAGENT_TOOL], concurrency: 1 });
		const wide = testAgent("wide", { tools: ["read", SUBAGENT_TOOL], concurrency: 3 });
		const fake = fakeSpawn(async () => ({ delayMs: 5 }));
		const tool = delegateTool({ agents: [scout, narrow, wide], holder: wide, spawn: fake.spawn, maxDepth: 3 });

		await callTool(tool, { agent: "narrow", tasks: ["split this"] });
		const childTool = offeredTools(fake.spawned[0]?.options ?? {})[0];
		await callTool(childTool as never, { agent: "scout", tasks: ["a", "b", "c"] });

		assert.equal(fake.maxConcurrent, 1, "the child's own file says one at a time, not its parent's three");
	});
});
