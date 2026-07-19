import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createEventBus, nextSubagentId, resetSubagentIds, type SubagentEvent } from "../src/events.ts";

const anEvent: SubagentEvent = { type: "status", id: "scout#1", status: "working" };

describe("createEventBus", () => {
	test("delivers to every subscriber", () => {
		const bus = createEventBus();
		const first: SubagentEvent[] = [];
		const second: SubagentEvent[] = [];

		bus.subscribe((event) => first.push(event));
		bus.subscribe((event) => second.push(event));
		bus.emit(anEvent);

		assert.deepEqual(first, [anEvent]);
		assert.deepEqual(second, [anEvent]);
	});

	test("unsubscribing stops delivery", () => {
		const bus = createEventBus();
		const seen: SubagentEvent[] = [];
		const unsubscribe = bus.subscribe((event) => seen.push(event));

		bus.emit(anEvent);
		unsubscribe();
		bus.emit(anEvent);

		assert.equal(seen.length, 1);
	});

	test("a throwing listener never stops the others: an observer is not a participant", () => {
		const bus = createEventBus();
		const seen: SubagentEvent[] = [];

		bus.subscribe(() => {
			throw new Error("broken reporter");
		});
		bus.subscribe((event) => seen.push(event));

		assert.doesNotThrow(() => bus.emit(anEvent));
		assert.deepEqual(seen, [anEvent]);
	});

	test("emitting with no subscriber at all is a no-op", () => {
		assert.doesNotThrow(() => createEventBus().emit(anEvent));
	});
});

describe("nextSubagentId", () => {
	beforeEach(() => resetSubagentIds());

	test("numbers each agent independently", () => {
		assert.equal(nextSubagentId("scout"), "scout#1");
		assert.equal(nextSubagentId("scout"), "scout#2");
		assert.equal(nextSubagentId("reviewer"), "reviewer#1");
	});

	test("ids are unique across a fan-out of the same agent", () => {
		const ids = new Set(Array.from({ length: 50 }, () => nextSubagentId("scout")));
		assert.equal(ids.size, 50);
	});
});
