/**
 * The flow runner: the turn it composes, typed outputs through `submit`, the
 * `choice` it walks, failures and how far they travel, retries, timeouts,
 * stops, memory scopes, and the visits it reports.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createEventBus, type SubagentEvent } from "../src/events.ts";
import { Run } from "../src/flow/run/walk.ts";
import { IN_THE_LANGUAGE_OF_THE_WORK } from "../src/language.ts";
import { stopSwitch } from "../src/stop.ts";
import { checked, flowSpawn, runChecked } from "./fixtures/flow.ts";

const CLOSING = "Answer by calling `submit` with the value asked for above: the call is your answer, and text you write beside it is not read.";

/** The visits a run reported, as `start path` and `end path ok`. */
function visits(events: SubagentEvent[]): string[] {
	return events.flatMap((event) => (event.type === "visit_start" ? [`start ${event.path}`] : event.type === "visit_end" ? [`end ${event.path} ${event.ok}`] : []));
}

const PLAN = `  - id: plan
    agent: planner
    reads: [input]
    output: { task: string, first: scout | reviewer }`;

describe("an agent visit", () => {
	test("is asked its section, each read under its address, the closing part, and the language line last", async () => {
		const flow = checked(`${PLAN}\n  - id: answer\n    agent: synthesiser\n    reads: [input, plan, plan.output.task]`, { plan: "Plan the request.", answer: "Answer it." });
		const fake = flowSpawn([[{ submit: { task: "find the cache", first: "scout" } }], [{ text: "It is in store.ts." }]]);
		const result = await runChecked(flow, "  add a cache\n", { spawn: fake.spawn });

		assert.deepEqual(result.ok && result.output, "It is in store.ts.");
		assert.equal(fake.created[0]?.prompts[0], `Plan the request.\n\n## input\n\nadd a cache\n\n${CLOSING}\n\n${IN_THE_LANGUAGE_OF_THE_WORK}`);
		const json = '```json\n{\n  "task": "find the cache",\n  "first": "scout"\n}\n```';
		assert.equal(fake.created[1]?.prompts[0], `Answer it.\n\n## input\n\nadd a cache\n\n## plan\n\n${json}\n\n## plan.output.task\n\nfind the cache\n\n${IN_THE_LANGUAGE_OF_THE_WORK}`);
	});

	test("a typed node gets the `submit` tool on top of its agent's own, and an untyped one does not", async () => {
		const flow = checked(`${PLAN}\n  - id: answer\n    agent: synthesiser`, { plan: "Plan.", answer: "Answer." });
		const fake = flowSpawn([[{ submit: { task: "t", first: "scout" } }], [{ text: "done" }]]);
		await runChecked(flow, "x", { spawn: fake.spawn });
		assert.deepEqual(fake.requested.map(({ agent }) => agent.tools), [["read", "grep", "find", "ls", "submit"], undefined]);
	});

	test("publishes the schema as the tool's parameters, a value that is not an object travelling in `value`", async () => {
		const flow = checked("  - id: list\n    agent: planner\n    output: [{ json-schema: { type: string, description: one file } }]", { list: "List." });
		const fake = flowSpawn([[{ submit: { value: ["a.ts", "b.ts"] } }]]);
		const result = await runChecked(flow, "x", { spawn: fake.spawn });
		assert.deepEqual(result.ok && result.output, ["a.ts", "b.ts"]);
		const [tool] = fake.requested[0]?.options.customTools ?? [];
		assert.deepEqual(tool?.parameters, {
			type: "object",
			properties: { value: { type: "array", items: { type: "string", description: "one file" } } },
			required: ["value"],
			additionalProperties: false,
		});
	});

	test("runs on the run's model, else the flow's, else the agent's own", async () => {
		const models = async (head: string, model?: string) => {
			const fake = flowSpawn([[{ text: "done" }]]);
			await runChecked(checked("  - id: look\n    agent: scout", { look: "Look." }, `input: string${head}`), "x", { spawn: fake.spawn, model });
			return fake.requested[0]?.options.model;
		};
		assert.deepEqual([await models("\nmodel: flow/m", "run/m"), await models("\nmodel: flow/m"), await models("")], ["run/m", "flow/m", undefined]);
	});

	test("a typed output is only ever the `submit` call: no call, or one off the schema, fails with `schema`", async () => {
		const flow = checked(PLAN, { plan: "Plan." });
		const none = await runChecked(flow, "x", { spawn: flowSpawn([[{ text: '{ "task": "t", "first": "scout" }' }]]).spawn });
		assert.deepEqual(!none.ok && [none.error, none.path], [{ kind: "schema", message: "the turn ended with no `submit` call" }, "plan"]);
		const off = await runChecked(flow, "x", { spawn: flowSpawn([[{ submit: { task: "t", first: "coder" } }]]).spawn });
		assert.deepEqual(!off.ok && off.error, { kind: "schema", message: '`first` is "coder", not scout | reviewer' });
	});

	test("`agent-from:` runs the agent the value names, among those written", async () => {
		const flow = checked(`${PLAN}\n  - id: first\n    agent-from: plan.output.first\n    among: [scout, reviewer]\n    reads: [plan.output.task]`, { plan: "Plan.", first: "Do it." });
		const fake = flowSpawn([[{ submit: { task: "t", first: "reviewer" } }], [{ text: "reviewed" }]]);
		const events: SubagentEvent[] = [];
		await runChecked(flow, "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.equal(fake.requested[1]?.agent.name, "reviewer");
		const ended = events.find((event) => event.type === "visit_end" && event.path === "first");
		assert.equal(ended?.type === "visit_end" && ended.agent, "reviewer");
	});
});

describe("a choice", () => {
	const GATE = `${PLAN}
  - id: gate
    choice:
      - when: plan.output.first == "scout"
        do:
          - id: look
            agent: scout
            reads: [plan.output.task]
    default: []
  - id: answer
    agent: synthesiser
    reads: [gate]`;
	const SECTIONS = { plan: "Plan.", look: "Look.", answer: "Answer." };

	test("runs the first case that holds, names it, and hands on its last node's output", async () => {
		const fake = flowSpawn([[{ submit: { task: "t", first: "scout" } }], [{ text: "found" }], [{ text: "answered" }]]);
		const events: SubagentEvent[] = [];
		const result = await runChecked(checked(GATE, SECTIONS), "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.ok(result.ok);
		assert.deepEqual(visits(events), ["start plan", "end plan true", "start gate", "start gate/look", "end gate/look true", "end gate true", "start answer", "end answer true"]);
		const gate = events.find((event) => event.type === "visit_end" && event.path === "gate");
		assert.deepEqual(gate?.type === "visit_end" && [gate.case, gate.output], ["1", { case: "1", output: "found" }]);
		assert.match(fake.created[2]?.prompts[0] ?? "", /## gate\n\n```json\n\{\n {2}"case": "1",\n {2}"output": "found"\n\}/);
	});

	test("runs its default when no case holds, `[]` running nothing", async () => {
		const fake = flowSpawn([[{ submit: { task: "t", first: "reviewer" } }], [{ text: "answered" }]]);
		const events: SubagentEvent[] = [];
		await runChecked(checked(GATE, SECTIONS), "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		const gate = events.find((event) => event.type === "visit_end" && event.path === "gate");
		assert.deepEqual(gate?.type === "visit_end" && gate.output, { case: "default" });
		assert.equal(fake.created.length, 2);
	});

	test("a condition that cannot be evaluated fails the choice with `condition`, never reads as false", async () => {
		const flow = checked(`${PLAN}\n    on-fail: continue\n  - id: gate\n    choice:\n      - when: plan.output.first == "scout"\n        do:\n          - id: look\n            agent: scout\n    default: []`, { plan: "Plan.", look: "Look." });
		const result = await runChecked(flow, "x", { spawn: flowSpawn([[{ text: "no call" }]]).spawn });
		assert.deepEqual(!result.ok && [result.error.kind, result.path], ["condition", "gate"]);
		assert.match(!result.ok ? result.error.message : "", /^`plan.output.first == "scout"`: `plan.output` is absent/);
	});
});

describe("a failure", () => {
	const FAILING = `  - id: gate
    choice:
      - when: "true"
        do:
          - id: look
            agent: scout
    default: []`;

	test("travels up through every enclosing node, the flow naming the visit it started at", async () => {
		const flow = checked(`${FAILING}\n  - id: after\n    agent: synthesiser`, { look: "Look.", after: "After." });
		const fake = flowSpawn([[{ stopReason: "error" }]]);
		const events: SubagentEvent[] = [];
		const result = await runChecked(flow, "x", { spawn: fake.spawn, onEvent: (event) => events.push(event) });
		assert.deepEqual(!result.ok && [result.error, result.path], [{ kind: "provider", message: "boom" }, "gate/look"]);
		const gate = events.find((event) => event.type === "visit_end" && event.path === "gate");
		assert.deepEqual(gate?.type === "visit_end" && gate.error, { kind: "child", message: "gate/look: provider: boom" });
		assert.equal(fake.created.length, 1, "nothing after the failure started");
	});

	test("stops at `on-fail: continue`, and a read of the failed node is its error as JSON", async () => {
		const flow = checked(`${FAILING}\n    on-fail: continue\n  - id: after\n    agent: synthesiser\n    reads: [gate]`, { look: "Look.", after: "After." });
		const fake = flowSpawn([[{ stopReason: "error" }], [{ text: "carried on" }]]);
		const result = await runChecked(flow, "x", { spawn: fake.spawn });
		assert.deepEqual(result.ok && result.output, "carried on");
		const failed = { ok: false, error: { kind: "child", message: "gate/look: provider: boom" } };
		assert.ok(fake.created[1]?.prompts[0]?.includes(`## gate\n\n\`\`\`json\n${JSON.stringify(failed, null, 2)}\n\`\`\``));
	});
});

describe("`retry:`", () => {
	test("resumes the same subagent with the failure named, and counts every attempt's tokens", async () => {
		const flow = checked("  - id: look\n    agent: scout\n    retry: 1", { look: "Look." });
		const fake = flowSpawn([[{ stopReason: "error", tokens: { input: 100 } }, { text: "found", tokens: { input: 30 } }]]);
		const result = await runChecked(flow, "x", { spawn: fake.spawn });
		assert.deepEqual(result.ok && result.output, "found");
		assert.equal(fake.created.length, 1);
		assert.equal(fake.created[0]?.prompts[1], `Your last answer failed (provider: boom). Do the same task again.\n\n${IN_THE_LANGUAGE_OF_THE_WORK}`);
		assert.equal(result.usage.input, 130);
	});

	test("is spent: a node with none left fails", async () => {
		const flow = checked("  - id: look\n    agent: scout\n    retry: 1", { look: "Look." });
		const result = await runChecked(flow, "x", { spawn: flowSpawn([[{ stopReason: "error" }, { stopReason: "error" }]]).spawn });
		assert.deepEqual(!result.ok && result.error.kind, "provider");
	});
});

describe("`timeout:`", () => {
	test("cuts a turn at its bound, and the run's own bound overrides every other", async () => {
		const flow = checked("  - id: look\n    agent: scout\n    timeout: 1h", { look: "Look." });
		const started = performance.now();
		const result = await runChecked(flow, "x", { spawn: flowSpawn([[{ delayMs: 5000 }]]).spawn, timeoutMs: 50 });
		assert.ok(performance.now() - started < 2000, "the turn was really cut short");
		assert.deepEqual(!result.ok && result.error, { kind: "timeout", message: "no answer within 50 ms" });
	});

	test("a retry after a timeout starts a fresh subagent, asked the whole turn again", async () => {
		const flow = checked("  - id: look\n    agent: scout\n    retry: 1", { look: "Look." });
		const fake = flowSpawn([[{ delayMs: 5000 }], [{ text: "found" }]]);
		const result = await runChecked(flow, "x", { spawn: fake.spawn, timeoutMs: 50 });
		assert.deepEqual(result.ok && result.output, "found");
		assert.deepEqual(fake.created.map((session) => session.disposed), [true, true]);
		assert.equal(fake.created[1]?.prompts[0], `Look.\n\n${IN_THE_LANGUAGE_OF_THE_WORK}`);
	});

	test("unless a memory scope keeps the subagent, which is then resumed", async () => {
		const flow = checked("  - id: look\n    agent: scout\n    memory: flow\n    retry: 1", { look: "Look." });
		const fake = flowSpawn([[{ delayMs: 5000 }, { text: "found" }]]);
		const result = await runChecked(flow, "x", { spawn: fake.spawn, timeoutMs: 50 });
		assert.ok(result.ok);
		assert.equal(fake.created.length, 1);
		assert.match(fake.created[0]?.prompts[1] ?? "", /^Your last answer failed \(timeout: no answer within 50 ms\)/);
	});

	test("resolves the nearest bound: the run's, the node's, the flow's, then thirty minutes", () => {
		const bound = (head: string, timeout: string, timeoutMs?: number) => {
			const flow = checked(`  - id: look\n    agent: scout${timeout}`, { look: "Look." }, `input: string${head}`);
			const node = flow.nodes[0];
			assert.equal(node?.kind, "agent");
			const run = new Run({ flow, bus: createEventBus(), signal: new AbortController().signal, spawn: flowSpawn([]).spawn, timeoutMs, deadline: () => new AbortController().signal, check: async () => ({ ok: false, kind: "unavailable", message: "" }), commit: async () => ({ ok: false, kind: "unavailable", message: "" }), diff: async () => ({ ok: true, value: "" }) });
			return run.timeoutFor(node as Extract<typeof node, { kind: "agent" }>);
		};
		assert.deepEqual([bound("\ntimeout: 2m", "\n    timeout: 90s", 5), bound("\ntimeout: 2m", "\n    timeout: 90s"), bound("\ntimeout: 2m", ""), bound("", "")], [5, 90_000, 120_000, 1_800_000]);
	});
});

describe("a stop", () => {
	const TWO = "  - id: look\n    agent: scout\n    retry: 1\n    on-fail: continue\n  - id: after\n    agent: synthesiser";

	test("of the run ends it `stopped`: nothing catches it and no node starts after it", async () => {
		const switcher = stopSwitch({ spawn: flowSpawn([[{ delayMs: 5000 }], [{ text: "never" }]]).spawn });
		const events: SubagentEvent[] = [];
		const running = runChecked(checked(TWO, { look: "Look.", after: "After." }), "x", { spawn: switcher.spawn, signal: switcher.signal, onEvent: (event) => events.push(event) });
		setTimeout(() => switcher.all(), 20);
		const result = await running;
		assert.deepEqual(!result.ok && [result.error.kind, result.path], ["stopped", "look"]);
		assert.deepEqual(visits(events), ["start look", "end look false"]);
	});

	test("of one visit is an ordinary failure: never retried, absorbed by `on-fail: continue`", async () => {
		const fake = flowSpawn([[{ delayMs: 5000 }, { text: "retried" }], [{ text: "after" }]]);
		const switcher = stopSwitch({ spawn: fake.spawn });
		const events: SubagentEvent[] = [];
		const onEvent = (event: SubagentEvent) => {
			events.push(event);
			if (event.type === "status" && event.status === "working" && event.id.startsWith("scout")) setTimeout(() => switcher.one(event.id), 20);
		};
		const result = await runChecked(checked(TWO, { look: "Look.", after: "After." }), "x", { spawn: switcher.spawn, signal: switcher.signal, onEvent });
		assert.deepEqual(result.ok && result.output, "after");
		const look = events.find((event) => event.type === "visit_end" && event.path === "look");
		assert.deepEqual(look?.type === "visit_end" && look.error, { kind: "stopped", message: "stopped" });
		assert.equal(fake.created[0]?.prompts.length, 1, "a stopped visit is not retried");
	});
});

describe("memory scopes", () => {
	test("`memory: flow` gives every node naming the agent one subagent, closed when the run ends", async () => {
		const flow = checked("  - id: ask\n    agent: reviewer\n    memory: flow\n  - id: brief\n    agent: reviewer\n    memory: flow", { ask: "Ask.", brief: "Brief." });
		const fake = flowSpawn([[{ text: "asked" }, { text: "briefed" }]]);
		await runChecked(flow, "x", { spawn: fake.spawn });
		assert.equal(fake.created.length, 1);
		assert.deepEqual(fake.created[0]?.prompts.map((prompt) => prompt.split("\n")[0]), ["Ask.", "Brief."]);
		assert.equal(fake.created[0]?.disposed, true);
	});

	test("with no `memory:`, each visit has a fresh subagent, closed when the visit ends", async () => {
		const flow = checked("  - id: ask\n    agent: reviewer\n  - id: brief\n    agent: reviewer", { ask: "Ask.", brief: "Brief." });
		const fake = flowSpawn([[{ text: "asked" }], [{ text: "briefed" }]]);
		let disposedWhenSecondSpawned: boolean | undefined;
		await runChecked(flow, "x", {
			spawn: async (agent, options) => {
				if (fake.created.length === 1) disposedWhenSecondSpawned = fake.created[0]?.disposed;
				return fake.spawn(agent, options);
			},
		});
		assert.equal(fake.created.length, 2);
		assert.equal(disposedWhenSecondSpawned, true);
	});

	test("a structural node's scope closes when its visit ends, a failure and a stop included", async () => {
		const flow = checked(
			`  - id: gate\n    choice:\n      - when: "true"\n        do:\n          - id: one\n            agent: scout\n            memory: gate\n          - id: two\n            agent: scout\n            memory: gate\n    default: []\n    on-fail: continue\n  - id: after\n    agent: synthesiser`,
			{ one: "One.", two: "Two.", after: "After." },
		);
		const fake = flowSpawn([[{ text: "one" }, { stopReason: "error" }], [{ text: "after" }]]);
		let disposedWhenAfterSpawned: boolean | undefined;
		const result = await runChecked(flow, "x", {
			spawn: async (agent, options) => {
				if (agent.name === "synthesiser") disposedWhenAfterSpawned = fake.created[0]?.disposed;
				return fake.spawn(agent, options);
			},
		});
		assert.ok(result.ok);
		assert.equal(fake.created[0]?.prompts.length, 2, "both nodes resumed one subagent");
		assert.equal(disposedWhenAfterSpawned, true);

		const hanging = flowSpawn([[{ delayMs: 5000 }]]);
		const switcher = stopSwitch({ spawn: hanging.spawn });
		const running = runChecked(flow, "x", { spawn: switcher.spawn, signal: switcher.signal });
		setTimeout(() => switcher.all(), 20);
		const stopped = await running;
		assert.deepEqual(!stopped.ok && stopped.error.kind, "stopped");
		assert.equal(hanging.created[0]?.disposed, true);
	});
});

describe("a visit's report", () => {
	test("`visit_end` carries the delta of pi's cumulative stats, the time and the agent", async () => {
		const flow = checked("  - id: one\n    agent: scout\n    memory: flow\n  - id: two\n    agent: scout\n    memory: flow", { one: "One.", two: "Two." });
		const events: SubagentEvent[] = [];
		const result = await runChecked(flow, "x", { spawn: flowSpawn([[{ text: "a", tokens: { input: 10, output: 2 } }, { text: "b", tokens: { input: 5, output: 1 } }]]).spawn, onEvent: (event) => events.push(event) });
		const ends = events.filter((event) => event.type === "visit_end");
		assert.deepEqual(ends.map((event) => event.type === "visit_end" && [event.path, event.usage.input, event.usage.output, event.agent]), [["one", 10, 2, "scout"], ["two", 5, 1, "scout"]]);
		assert.ok(ends.every((event) => event.type === "visit_end" && event.wallMs >= 0 && event.usage.wallMs === event.wallMs));
		assert.deepEqual([result.usage.input, result.usage.output], [15, 3]);
		const spawned = events.filter((event) => event.type === "spawn");
		assert.deepEqual(spawned.map((event) => event.type === "spawn" && event.visit), ["one"], "a scope's subagent names the first visit that asked for it");
	});
});

describe("what the runner refuses before the first spawn", () => {
	test("an input off the flow's `input:`", async () => {
		const fake = flowSpawn([]);
		const typed = checked("  - id: one\n    agent: scout\n    reads: [input]", { one: "One." }, "input: { task: string }");
		await assert.rejects(runChecked(typed, "x", { spawn: fake.spawn }), /does not match its `input:`: the value is "x", not \{ task: string \}/);
		assert.equal(fake.created.length, 0);
	});
});
