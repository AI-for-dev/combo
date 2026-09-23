/**
 * The structural nodes that open branches, checked: `choice`, `parallel` and
 * `map`, their scopes, the types they hand on, and the copies rule.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Agent } from "../src/agent.ts";
import { checkFlow, showType, type CheckedMapNode, type FlowCatalogue } from "../src/flow/index.ts";

function agent(name: string, tools?: string[]): Agent {
	return { name, description: `the ${name}`, systemPrompt: `You are the ${name}.`, tools, source: "builtin", filePath: `agents/${name}.md` };
}

const AGENTS = [agent("scout"), agent("planner"), agent("reviewer"), agent("synthesiser"), agent("coder", ["read", "write", "edit"])];

/** A flow `f` whose nodes are `nodes` (YAML lines under `nodes:`) and whose agent nodes each get a section. */
function check(nodes: string, sections: string[]) {
	const body = sections.map((id) => `## ${id}\nDo it.`).join("\n\n");
	const catalogue: FlowCatalogue = { flows: [{ name: "f", filePath: "flows/f.md", content: `---\nname: f\ndescription: d\ninput: string\nnodes:\n${nodes}\n---\n${body}` }], agents: AGENTS };
	return checkFlow("f", catalogue);
}

function faults(nodes: string, sections: string[]) {
	const result = check(nodes, sections);
	assert.ok(!result.ok, "expected the flow to be refused");
	return result.faults.map(({ code, at }) => `${code} ${at}`);
}

function passes(nodes: string, sections: string[]) {
	const result = check(nodes, sections);
	assert.ok(result.ok, JSON.stringify(!result.ok && result.faults, null, 1));
	return result.flow;
}

const PLAN = `  - id: plan
    agent: planner
    output: { tasks: [{ worker: scout | reviewer, task: string }] }`;

describe("map", () => {
	test("a literal list lends `item` as a string, and hands on a list of items", () => {
		const flow = passes(
			`  - id: look
    map: [where is it, how is it tested]
    concurrency: 2
    do:
      - id: find
        agent: scout
        reads: [input, item]
  - id: answer
    agent: synthesiser
    reads: [look]`,
			["find", "answer"],
		);
		const [look, answer] = flow.nodes;
		assert.equal(look?.kind, "map");
		assert.deepEqual((look as CheckedMapNode).over, { items: ["where is it", "how is it tested"] });
		assert.equal(answer?.kind === "agent" && showType(answer.reads[0]?.type ?? { kind: "text" }), "[{ item: string, ok: boolean, output?: text, error?: { kind: provider | timeout | schema | stopped | cancelled | condition | child | nobody | unavailable | empty-message | unconverged | too-many, message: string } }]");
	});

	test("`map-from:` reads a list, bound by `max:`, and `item` is its element", () => {
		const flow = passes(
			`${PLAN}
  - id: work
    map-from: plan.output.tasks
    max: 4
    do:
      - id: act
        agent-from: item.worker
        among: [scout, reviewer]
        reads: [item.task]`,
			["plan", "act"],
		);
		const work = flow.nodes[1] as CheckedMapNode;
		assert.deepEqual([work.over, work.max, work.concurrency], [{ from: "plan.output.tasks" }, 4, 1]);
	});

	test("the bound is required with an address, and refused with a literal list", () => {
		assert.deepEqual(faults(`${PLAN}\n  - id: work\n    map-from: plan.output.tasks\n    do:\n      - id: act\n        agent: scout`, ["plan", "act"]), ["missing-key work.max"]);
		assert.deepEqual(faults(`  - id: work\n    map: [a]\n    max: 2\n    do:\n      - id: act\n        agent: scout`, ["act"]), ["unknown-key work.max"]);
		assert.deepEqual(faults(`${PLAN}\n  - id: work\n    map-from: plan.output.tasks\n    max: 2\n    concurrency: 0\n    do: []`, ["plan"]), ["key-type work.concurrency", "key-type work.do"]);
		assert.deepEqual(faults(`${PLAN}\n  - id: work\n    map-from: plan.output\n    max: 2\n    do:\n      - id: act\n        agent: scout`, ["plan", "act"]), ["key-type work.map-from"]);
	});

	test("`item` and the body's nodes are readable inside the map, and nowhere after it", () => {
		assert.deepEqual(
			faults(`  - id: work\n    map: [a]\n    do:\n      - id: act\n        agent: scout\n  - id: after\n    agent: synthesiser\n    reads: [item, act]`, ["act", "after"]),
			["unknown-address after.reads", "unknown-address after.reads"],
		);
	});

	test("a nested map's `item` hides the outer one", () => {
		const flow = passes(
			`${PLAN}\n  - id: outer\n    map-from: plan.output.tasks\n    max: 2\n    do:\n      - id: inner\n        map: [x]\n        do:\n          - id: act\n            agent: scout\n            reads: [item]`,
			["plan", "act"],
		);
		const act = [...(flow.nodes[1] as CheckedMapNode).nodes][0] as CheckedMapNode;
		assert.equal(act.nodes[0]?.kind === "agent" && act.nodes[0].reads[0]?.type.kind, "string");
	});
});

describe("choice", () => {
	const GO = `  - id: go\n    agent: planner\n    output: { ready: boolean, note: string }`;

	test("its conditions read what ended before it, and it hands on which case ran", () => {
		const flow = passes(
			`${GO}
  - id: gate
    choice:
      - when: go.output.ready
        do:
          - id: now
            agent: scout
            output: { found: boolean }
    default:
      - id: later
        agent: reviewer
        output: { found: boolean }
  - id: after
    agent: synthesiser
    reads: [gate.output.case, gate.output.output.found]`,
			["go", "now", "later", "after"],
		);
		const after = flow.nodes[2];
		assert.deepEqual(after?.kind === "agent" && after.reads.map((read) => showType(read.type)), ["1 | default", "boolean"]);
	});

	test("a case's output is typed only when every case that runs a node ends on one type, and optional with an empty one", () => {
		const cases = (other: string) => `${GO}\n  - id: gate\n    choice:\n      - when: go.output.ready\n        do:\n          - id: now\n            agent: scout\n            output: { found: boolean }\n    default: ${other}\n  - id: after\n    agent: synthesiser\n    reads: [gate.output.output]`;
		const flow = passes(cases("[]"), ["go", "now", "after"]);
		assert.equal(flow.nodes[2]?.kind === "agent" && showType(flow.nodes[2].reads[0]?.type ?? { kind: "text" }), "{ found: boolean }");
		assert.deepEqual(faults(cases("\n      - id: later\n        agent: reviewer"), ["go", "now", "later", "after"]), ["unknown-address after.reads"]);
	});

	test("`default:` is always written, a case runs a node, and a condition is checked", () => {
		assert.deepEqual(faults(`${GO}\n  - id: gate\n    choice:\n      - when: go.output.ready\n        do: []`, ["go"]), ["key-type gate.choice[0].do", "missing-key gate.default"]);
		const typo = `${GO}\n  - id: gate\n    choice:\n      - when: go.output.redy\n        do:\n          - id: now\n            agent: scout\n    default: []`;
		assert.deepEqual(faults(typo, ["go", "now"]), ["condition-unknown-address gate.choice[0].when"]);
	});

	test("a condition reads typed values only", () => {
		const said = check(`  - id: go\n    agent: planner\n  - id: gate\n    choice:\n      - when: go.output == "yes"\n        do:\n          - id: now\n            agent: scout\n    default: []`, ["go", "now"]);
		assert.ok(!said.ok);
		assert.deepEqual(said.faults.map((f) => [f.code, f.message]), [["condition-type", "`go.output` is text, written with no `output:` schema; a condition reads typed values only"]]);
	});
});

describe("parallel", () => {
	test("hands on an object of its branches by name, each as it ended", () => {
		const flow = passes(
			`  - id: both\n    parallel:\n      left:\n        - id: a\n          agent: scout\n      right:\n        - id: b\n          agent: reviewer\n          output: { ok_to_ship: boolean }\n  - id: after\n    agent: synthesiser\n    reads: [both.output.right.output.ok_to_ship, both.output.left.ok]`,
			["a", "b", "after"],
		);
		assert.deepEqual(flow.nodes[1]?.kind === "agent" && flow.nodes[1].reads.map((read) => read.type.kind), ["boolean", "boolean"]);
	});

	test("has at least two branches, each named as a field and running a node", () => {
		assert.deepEqual(faults(`  - id: both\n    parallel:\n      only:\n        - id: a\n          agent: scout`, ["a"]), ["key-type both.parallel", "section-unknown a"]);
		assert.deepEqual(faults(`  - id: both\n    parallel:\n      left-side:\n        - id: a\n          agent: scout\n      right: []`, ["a"]), ["key-type both.parallel.left-side", "key-type both.parallel.right"]);
	});
});

describe("the copies rule", () => {
	const coding = (options: string) => `${PLAN}\n  - id: work\n    map-from: plan.output.tasks\n    max: 4\n${options}\n    do:\n      - id: code\n        agent: coder`;

	test("items that run together and write need copies", () => {
		assert.deepEqual(faults(coding("    concurrency: 2"), ["plan", "code"]), ["copies-needed work.copies"]);
		const said = check(coding("    concurrency: 2"), ["plan", "code"]);
		assert.ok(!said.ok);
		assert.equal(said.faults[0]?.message, "`concurrency: 2` runs items at once, and `work/code` writes (`coder` has write, edit): give each branch its own copy with `copies: true`, or `concurrency: 1`");
		passes(coding("    concurrency: 2\n    copies: true"), ["plan", "code"]);
		passes(coding("    concurrency: 1"), ["plan", "code"]);
	});

	test("so do parallel branches, as soon as one writes", () => {
		const lines = `  - id: both\n    parallel:\n      read:\n        - id: a\n          agent: scout\n      write:\n        - id: b\n          agent: coder`;
		assert.deepEqual(faults(lines, ["a", "b"]), ["copies-needed both.copies"]);
		passes(`${lines}\n    copies: true`, ["a", "b"]);
	});
});

describe("nesting", () => {
	test("`memory:` names a node this one is in", () => {
		const lines = `  - id: work\n    map: [a]\n    do:\n      - id: act\n        agent: scout\n        memory: work\n  - id: after\n    agent: scout\n    memory: work`;
		assert.deepEqual(faults(lines, ["act", "after"]), ["unknown-scope after.memory"]);
	});

	test("a fault inside a block is at its path, an id is unique across blocks, and prose is for agent nodes", () => {
		const lines = `  - id: work\n    map: [a]\n    do:\n      - id: act\n        agent: scout\n        reeds: [item]\n      - id: work\n        agent: scout`;
		assert.deepEqual(faults(lines, ["act", "work"]), ["unknown-key work/act.reeds", "duplicate-id work/work", "section-not-agent work"]);
		assert.deepEqual(faults(`${lines}\n  - id: after\n    agent: synthesiser\n    reads: [work, act]`, ["act", "work", "after"]).length, 3, "nothing about the block that holds a refused node");
	});
});
