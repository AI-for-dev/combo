/**
 * A flow file read and checked against its catalogue: every fault at once, in
 * file order, by stable code, and one mistake reported once.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { Agent } from "../src/agent.ts";
import { checkFlow, FAULT_CODES, type CheckedAgentNode, type FlowCatalogue } from "../src/flow/index.ts";

function agent(name: string): Agent {
	return { name, description: `the ${name}`, systemPrompt: `You are the ${name}.`, source: "builtin", filePath: `agents/${name}.md` };
}

const AGENTS = ["scout", "planner", "reviewer", "synthesiser"].map(agent);

/** A catalogue holding one flow file, `name.md`, written as frontmatter lines and a body. */
function catalogue(frontmatter: string, body: string, name = "split"): FlowCatalogue {
	return { flows: [{ name, filePath: `flows/${name}.md`, content: `---\n${frontmatter}\n---\n${body}` }], agents: AGENTS };
}

const HEAD = "name: split\ndescription: Split a question between two agents\ninput: string";

function faults(frontmatter: string, body: string) {
	const result = checkFlow("split", catalogue(frontmatter, body));
	assert.ok(!result.ok, "expected the flow to be refused");
	return result.faults.map(({ code, at }) => `${code} ${at}`);
}

function messages(frontmatter: string, body: string) {
	const result = checkFlow("split", catalogue(frontmatter, body));
	assert.ok(!result.ok, "expected the flow to be refused");
	return result.faults.map(({ message }) => message);
}

const SPLIT = `${HEAD}
timeout: 20m
nodes:
  - id: plan
    agent: planner
    reads: [input]
    output: { tasks: [{ worker: scout | reviewer, task: string }], first: scout | reviewer }
  - id: first
    agent-from: plan.output.first
    among: [scout, reviewer]
    memory: flow
    reads: [plan.output.tasks, plan]
    retry: 1
    timeout: 90s
    on-fail: continue
  - id: answer
    agent: synthesiser
    reads: [input, first, first.ok]`;

const SPLIT_BODY = `## plan
Split the request.

## first
Do the first task.

\`\`\`markdown
## not a section
\`\`\`

## answer
Answer from the reports.
`;

describe("checkFlow, a flow that passes", () => {
	test("resolves its agents, types its reads and attaches its prose", () => {
		const result = checkFlow("split", catalogue(SPLIT, SPLIT_BODY));
		assert.ok(result.ok, JSON.stringify(!result.ok && result.faults));
		const { flow } = result;
		assert.equal(flow.timeoutMs, 20 * 60_000);
		assert.deepEqual(flow.nodes.map((node) => node.id), ["plan", "first", "answer"]);
		const [plan, first, answer] = flow.nodes as CheckedAgentNode[];
		assert.equal(plan?.agent, AGENTS[1]);
		assert.equal(plan?.prose, "Split the request.");
		assert.ok(first && !("name" in first.agent));
		assert.equal(first.agent.from, "plan.output.first");
		assert.deepEqual([...first.agent.among.keys()], ["scout", "reviewer"]);
		assert.match(first.prose, /## not a section/, "a heading inside a fence is prose");
		assert.deepEqual([first.memory, first.retry, first.timeoutMs, first.continueOnFail], ["flow", 1, 90_000, true]);
		assert.deepEqual(first.reads.map((read) => [read.address, read.type.kind]), [["plan.output.tasks", "list"], ["plan", "object"]]);
		assert.deepEqual(answer?.reads.map((read) => [read.address, read.type.kind]), [["input", "string"], ["first", "text"], ["first.ok", "boolean"]]);
	});
});

describe("checkFlow, the file", () => {
	test("a YAML syntax error is the only fault, with its line in the file", () => {
		const result = checkFlow("split", catalogue(`${HEAD}\nnodes: [oops`, ""));
		assert.ok(!result.ok);
		assert.deepEqual(result.faults.map((f) => f.code), ["yaml-syntax"]);
		assert.match(result.faults[0]?.message ?? "", /line 5/);
	});

	test("a file with no frontmatter is not a flow", () => {
		assert.deepEqual(faults("", "## plan\nx"), ["not-a-flow "]);
	});

	test("refuses a missing or unknown flow key, with the nearest one", () => {
		const frontmatter = "name: split\ndescripton: typo\ninput: string\nnodes:\n  - id: plan\n    agent: planner";
		assert.deepEqual(faults(frontmatter, "## plan\nPlan."), ["unknown-key descripton", "missing-key description"]);
		assert.match(messages(frontmatter, "## plan\nPlan.")[0] ?? "", /did you mean `description`\?/);
	});

	test("a flow is found by its file name, and its name says the same", () => {
		const result = checkFlow("other", catalogue(SPLIT, SPLIT_BODY, "other"));
		assert.ok(!result.ok);
		assert.deepEqual(result.faults.map((f) => `${f.code} ${f.at}`), ["name-mismatch name"]);
		const unknown = checkFlow("splt", catalogue(SPLIT, SPLIT_BODY));
		assert.ok(!unknown.ok);
		assert.deepEqual(unknown.faults.map((f) => [f.code, f.message]), [["unknown-flow", "`splt` is unknown; did you mean `split`?"]]);
	});

	test("the input is a schema", () => {
		assert.deepEqual(faults("name: split\ndescription: d\ninput: strng\nnodes:\n  - id: plan\n    agent: planner", "## plan\nPlan."), ["schema-invalid input"]);
	});
});

describe("checkFlow, nodes", () => {
	const node = (lines: string) => faults(`${HEAD}\nnodes:\n${lines}`, "## plan\nPlan.");

	test("an id is present, a CEL identifier, not an address word, and unique", () => {
		assert.deepEqual(node("  - agent: planner"), ["missing-key nodes[0].id", "section-unknown plan"]);
		assert.deepEqual(node("  - id: ask-next\n    agent: planner"), ["invalid-id ask-next", "section-unknown plan"]);
		assert.match(messages(`${HEAD}\nnodes:\n  - id: ask-next\n    agent: planner`, "")[0] ?? "", /name it `ask_next`/);
		assert.deepEqual(node("  - id: input\n    agent: planner"), ["reserved-id input", "section-unknown plan"]);
		assert.deepEqual(node("  - id: loop\n    agent: planner"), ["reserved-id loop", "section-unknown plan"]);
		assert.deepEqual(node("  - id: plan\n    agent: planner\n  - id: plan\n    agent: scout"), ["duplicate-id plan"]);
	});

	test("a node has exactly one kind, and a literal or an address, not both", () => {
		assert.deepEqual(node("  - id: plan\n    reads: [input]"), ["node-kind plan"]);
		assert.deepEqual(node("  - id: plan\n    agent: planner\n    agent-from: input\n    among: [scout]"), ["twin-keys plan"]);
	});

	test("refuses an unknown key with the nearest one, a key of another kind included", () => {
		assert.deepEqual(node("  - id: plan\n    agent: planner\n    reeds: [input]\n    max: 3"), ["unknown-key plan.reeds", "unknown-key plan.max"]);
		const said = messages(`${HEAD}\nnodes:\n  - id: plan\n    agent: planner\n    reeds: [input]\n    max: 3`, "## plan\nPlan.");
		assert.match(said[0] ?? "", /did you mean `reads`\?/);
		assert.match(said[1] ?? "", /the keys of an agent node are id, agent, agent-from/);
	});

	test("every key has one type", () => {
		assert.deepEqual(node("  - id: plan\n    agent: planner\n    retry: '2'\n    timeout: 10 minutes\n    reads: plan\n    on-fail: stop"), [
			"key-type plan.retry",
			"key-type plan.timeout",
			"key-type plan.reads",
			"key-type plan.on-fail",
		]);
	});

	test("`among:` goes with `agent-from:`, and `agent-from:` needs it", () => {
		assert.deepEqual(node("  - id: plan\n    agent: planner\n    among: [scout]"), ["among-without-from plan.among"]);
		assert.deepEqual(node("  - id: plan\n    agent-from: input"), ["missing-key plan.among"]);
	});

	test("a refused node is reported once: nothing that refers to it is", () => {
		const lines = "  - id: plan\n    agent: planner\n    reeds: [input]\n  - id: answer\n    agent: synthesiser\n    reads: [plan, plan.output.x]";
		assert.deepEqual(faults(`${HEAD}\nnodes:\n${lines}`, "## plan\nPlan.\n\n## answer\nAnswer."), ["unknown-key plan.reeds"]);
	});
});

describe("checkFlow, sections", () => {
	const nodes = `${HEAD}\nnodes:\n  - id: plan\n    agent: planner\n  - id: answer\n    agent: synthesiser`;

	test("every agent node has one, and there is nothing else in the body; a node's faults come before the body's", () => {
		assert.deepEqual(faults(nodes, "Intro.\n\n## plan\nPlan.\n\n## anwser\nAnswer."), ["section-missing answer", "body-preamble ", "section-unknown anwser"]);
		assert.match(messages(nodes, "## plan\nPlan.\n\n## anwser\nAnswer.")[1] ?? "", /did you mean `answer`\?/);
	});

	test("a section says something, once", () => {
		assert.deepEqual(faults(nodes, "## plan\n\n## answer\nAnswer.\n\n## answer\nAgain."), ["section-empty plan", "section-duplicate answer"]);
	});
});

describe("checkFlow, names", () => {
	const flow = (lines: string) => faults(`${HEAD}\nnodes:\n  - id: plan\n    agent: planner\n    output: { worker: scout | reviewer, note: string }\n${lines}`, "## plan\nPlan.\n\n## next\nNext.");

	test("an agent is one of the catalogue's, with the nearest one offered", () => {
		assert.deepEqual(flow("  - id: next\n    agent: reviewr"), ["unknown-agent next.agent"]);
		assert.match(messages(`${HEAD}\nnodes:\n  - id: next\n    agent: reviewr`, "## next\nNext.")[0] ?? "", /did you mean `reviewer`\?/);
	});

	test("`agent-from:` reads an enum, and `among:` names exactly its values, each an agent", () => {
		assert.deepEqual(flow("  - id: next\n    agent-from: plan.output.note\n    among: [scout]"), ["key-type next.agent-from"]);
		assert.deepEqual(flow("  - id: next\n    agent-from: plan.output.worker\n    among: [scout, planner]"), ["among-mismatch next.among"]);
		assert.deepEqual(flow("  - id: next\n    agent-from: plan.output.worker\n    among: [scout, reviewr]"), ["unknown-agent next.among", "among-mismatch next.among"]);
	});

	test("a read names something that already ended, down to a field that exists", () => {
		assert.deepEqual(flow("  - id: next\n    agent: reviewer\n    reads: [plan.output.nope, later, nothing, next]\n  - id: later\n    agent: scout"), [
			"unknown-address next.reads",
			"unknown-address next.reads",
			"unknown-address next.reads",
			"unknown-address next.reads",
			"section-missing later",
		]);
	});

	test("an agent's text is read whole, never into", () => {
		const said = messages(`${HEAD}\nnodes:\n  - id: plan\n    agent: planner\n  - id: next\n    agent: reviewer\n    reads: [plan.output.subtasks]`, "## plan\nPlan.\n\n## next\nNext.");
		assert.deepEqual(said, ["`plan.output` is text, read whole, which has no field `subtasks`"]);
	});

	test("`memory:` names an enclosing node, or the flow", () => {
		assert.deepEqual(flow("  - id: next\n    agent: reviewer\n    memory: pair"), ["unknown-scope next.memory"]);
	});
});

describe("the fault codes", () => {
	test("every code has its row in the guide's table, and the table names no other", () => {
		const guide = readFileSync(new URL("../docs/guide/flows.md", import.meta.url), "utf-8");
		const table = guide.slice(guide.indexOf("## Faults"));
		const rows = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
		assert.deepEqual(rows, [...FAULT_CODES]);
	});
});
