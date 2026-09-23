/**
 * A `loop`, checked: its bound and its conditions, what one iteration reads
 * of the loop (`previous`, `carry`, `ledger`), and the verdict that writes to
 * a ledger.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Agent } from "../src/agent.ts";
import { checkFlow, showType, type CheckedLoopNode, type FlowCatalogue } from "../src/flow/index.ts";

function agent(name: string, tools?: string[]): Agent {
	return { name, description: `the ${name}`, systemPrompt: `You are the ${name}.`, tools, source: "builtin", filePath: `agents/${name}.md` };
}

const AGENTS = ["scout", "planner", "reviewer", "auditor"].map((name) => agent(name)).concat(agent("coder", ["read", "write", "edit"]));

function check(nodes: string, sections: string[]) {
	const body = sections.map((id) => `## ${id}\nDo it.`).join("\n\n");
	const catalogue: FlowCatalogue = { flows: [{ name: "f", filePath: "flows/f.md", source: "project", content: `---\nname: f\ndescription: d\ninput: string\nnodes:\n${nodes}\n---\n${body}` }], agents: AGENTS, brokenAgents: [], cwd: "." };
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

/** The shipped `build`'s delivery, minus the check node that comes with its own PR. */
const BUILD = `  - id: plan
    agent: planner
    reads: [input]
    output: { subtasks: [{ text: string }] }
  - id: deliver
    loop: audit.output.approved
    max: 2
    ledger: deliver
    carry: { first: plan.output.subtasks, next: deliver.ledger }
    give-up: size(deliver.ledger) == 0
    do:
      - id: work
        map-from: deliver.carry
        max: 6
        concurrency: 2
        copies: true
        do:
          - id: pair
            loop: review.output.approved
            max: 3
            ledger: pair
            do:
              - id: code
                agent: coder
                memory: pair
                retry: 1
                reads: [item, pair.previous.review, pair.ledger]
              - id: review
                agent: reviewer
                memory: pair
                verdict: pair
                reads: [item, code]
      - id: audit
        agent: auditor
        verdict: deliver
        reads: [input, plan, deliver.ledger]
  - id: report
    agent: scout
    reads: [deliver.output.converged, deliver.output.last.audit.output.remarks]`;

const BUILD_SECTIONS = ["plan", "code", "review", "audit", "report"];

describe("loop", () => {
	test("the shipped build's delivery checks, and each read is typed", () => {
		const flow = passes(BUILD, BUILD_SECTIONS);
		const deliver = flow.nodes[1] as CheckedLoopNode;
		assert.deepEqual([deliver.max, deliver.ledger, deliver.carry, deliver.until.source, deliver.giveUp?.source], [
			2,
			true,
			{ first: "plan.output.subtasks", next: "deliver.ledger" },
			"audit.output.approved",
			"size(deliver.ledger) == 0",
		]);
		const code = [...(flow.nodes[1] as CheckedLoopNode).nodes][0];
		const pair = code?.kind === "map" ? code.nodes[0] : undefined;
		const coder = pair?.kind === "loop" ? pair.nodes[0] : undefined;
		assert.deepEqual(coder?.kind === "agent" && coder.reads.map((read) => [read.address, showType(read.type)]), [
			["item", "{ text: string }"],
			["pair.previous.review", "{ ok: boolean, output?: { approved: boolean, remarks?: string }, error?: { kind: provider | timeout | schema | stopped | cancelled | condition | child | nobody | unavailable | empty-message | unconverged | too-many, message: string } }"],
			["pair.ledger", "[{ id: string, text: string }]"],
		]);
		const report = flow.nodes[2];
		assert.deepEqual(report?.kind === "agent" && report.reads.map((read) => showType(read.type)), ["boolean", "string"]);
	});

	test("`until` and `max` are required, and the body runs a node", () => {
		assert.deepEqual(faults(`  - id: again\n    loop: a.ok\n    do: []`, []), ["missing-key again.max", "key-type again.do"]);
		assert.deepEqual(faults(`  - id: again\n    loop: a.ok\n    max: 0\n    do:\n      - id: a\n        agent: scout`, ["a"]), ["key-type again.max"]);
	});

	test("its conditions read the body as it ended, and are checked", () => {
		const lines = `  - id: again\n    loop: review.output.aproved\n    max: 2\n    give-up: size(review) == 0\n    do:\n      - id: review\n        agent: reviewer\n        output: { approved: boolean }`;
		assert.deepEqual(faults(lines, ["review"]), ["condition-unknown-address again.loop", "condition-type again.give-up"]);
	});

	test("the body's nodes, `previous` and the loop's own fields are readable inside it only", () => {
		const lines = `  - id: again\n    loop: a.ok\n    max: 2\n    do:\n      - id: a\n        agent: scout\n        reads: [again.previous.a]\n  - id: after\n    agent: scout\n    reads: [a, again.previous]`;
		assert.deepEqual(faults(lines, ["a", "after"]), ["unknown-address after.reads", "unknown-address after.reads"]);
	});

	test("a carry is what both of its sides share, and refused when they share nothing", () => {
		const lines = (next: string) => `  - id: plan\n    agent: planner\n    output: { tasks: [{ text: string }] }\n  - id: again\n    loop: a.ok\n    max: 2\n    ledger: again\n    carry: { first: plan.output.tasks, next: ${next} }\n    do:\n      - id: a\n        agent: scout\n        reads: [again.carry]`;
		const flow = passes(lines("again.ledger"), ["plan", "a"]);
		const a = (flow.nodes[1] as CheckedLoopNode).nodes[0];
		assert.equal(a?.kind === "agent" && showType(a.reads[0]?.type ?? { kind: "text" }), "[{ text: string }]");
		assert.deepEqual(faults(lines("a.ok"), ["plan", "a"]), ["carry-mismatch again.carry"]);
		assert.deepEqual(faults(`  - id: again\n    loop: a.ok\n    max: 2\n    carry: { first: input }\n    do:\n      - id: a\n        agent: scout`, ["a"]), ["missing-key again.carry.next"]);
	});

	test("a ledger is named after the node that opens it", () => {
		assert.deepEqual(faults(`  - id: again\n    loop: a.ok\n    max: 2\n    ledger: other\n    do:\n      - id: a\n        agent: scout`, ["a"]), ["key-type again.ledger"]);
	});
});

describe("verdict", () => {
	test("names an enclosing node that keeps a ledger, and is the node's output", () => {
		const lines = `  - id: again\n    loop: a.output.approved\n    max: 2\n    do:\n      - id: a\n        agent: reviewer\n        verdict: again`;
		assert.deepEqual(faults(lines, ["a"]), ["unknown-scope again/a.verdict"]);
		assert.deepEqual(faults(`  - id: again\n    loop: a.ok\n    max: 2\n    ledger: again\n    do:\n      - id: a\n        agent: reviewer\n        verdict: again\n        output: { x: string }`, ["a"]), ["verdict-with-output again/a.verdict"]);
	});

	test("a map's ledger is one per item, and a verdict inside it may name it", () => {
		passes(`  - id: work\n    map: [a, b]\n    ledger: work\n    do:\n      - id: judge\n        agent: reviewer\n        verdict: work\n        reads: [work.ledger]`, ["judge"]);
	});
});
