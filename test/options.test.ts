import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolDefinition } from "../src/session.ts";
import { toolsOffered } from "../src/subagent.ts";
import { offerBoth, type ToolOffer } from "../src/workflows/options.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

const scout = testAgent("scout");
const tool = (name: string) => ({ name }) as ToolDefinition;
const names = (offer: ToolOffer | undefined) => toolsOffered(offer?.(scout), "scout#1").map((one) => one.name);

describe("offerBoth", () => {
	test("a list beside a function: both are asked for the id, and the order is the callers'", () => {
		const both = offerBoth(
			() => [tool("hammer")],
			() => (id) => [tool(`board-for-${id}`)],
		);
		assert.deepEqual(names(both), ["hammer", "board-for-scout#1"]);
	});

	test("an offer beside nothing is that offer, untouched", () => {
		const only: ToolOffer = () => [tool("hammer")];
		assert.equal(offerBoth(only, undefined), only);
		assert.equal(offerBoth(undefined, only), only);
	});

	test("an agent offered nothing by one side gets the other's, and nothing by both gets nothing", () => {
		const both = offerBoth(
			(agent) => (agent.name === "scout" ? [tool("hammer")] : undefined),
			() => undefined,
		);
		assert.deepEqual(names(both), ["hammer"]);
		assert.equal(both?.(testAgent("coder")), undefined);
	});
});

describe("toolsOffered", () => {
	test("a list is a list, a function is asked for the id, nothing is an empty list", () => {
		assert.deepEqual(toolsOffered([tool("a")], "x").map((one) => one.name), ["a"]);
		assert.deepEqual(toolsOffered((id) => [tool(id)], "x").map((one) => one.name), ["x"]);
		assert.deepEqual(toolsOffered(undefined, "x"), []);
	});
});
