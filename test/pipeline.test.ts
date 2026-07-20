import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parsePipeline, STEP_KINDS } from "../src/pipeline.ts";

function pipeline(frontmatter: string, body: string): string {
	return ["---", frontmatter.trim(), "---", "", body.trim(), ""].join("\n");
}

const BUILD = pipeline(
	`
name: build
description: Plan, implement in pairs, audit
verify: [npm, test]
steps:
  - id: plan
    orchestrate: planner
    workers: [coder, scout]
    maxTasks: 6
  - id: implement
    loop: [coder, reviewer]
    lifetime: workflow
    until: APPROVED
    maxIterations: 3
`,
	`
## plan
Split the brief into independent subtasks.

## implement
Apply the plan.
The reviewer approves with APPROVED and nothing else.
`,
);

describe("parsePipeline", () => {
	test("reads the structure from the frontmatter and the prose from the body", () => {
		const parsed = parsePipeline(BUILD, "/x/build.md");

		assert.equal(parsed.name, "build");
		assert.equal(parsed.description, "Plan, implement in pairs, audit");
		// A list, not a command line: splitting on whitespace is writing a shell.
		assert.deepEqual(parsed.verify, ["npm", "test"]);
		assert.deepEqual(
			parsed.steps.map((step) => step.id),
			["plan", "implement"],
		);

		const [plan, implement] = parsed.steps;
		assert.equal(plan?.kind, "orchestrate");
		assert.deepEqual(plan?.agents, ["planner"]);
		assert.deepEqual(plan?.workers, ["coder", "scout"]);
		assert.equal(plan?.maxTasks, 6);
		assert.equal(plan?.prompt, "Split the brief into independent subtasks.");

		assert.equal(implement?.kind, "loop");
		assert.deepEqual(implement?.agents, ["coder", "reviewer"]);
		assert.equal(implement?.lifetime, "workflow");
		assert.equal(implement?.until, "APPROVED");
		assert.equal(implement?.maxIterations, 3);
		assert.match(implement?.prompt ?? "", /^Apply the plan\.\nThe reviewer approves/);
	});

	test("accepts a lone agent where a list is allowed", () => {
		const parsed = parsePipeline(
			pipeline("name: p\nsteps:\n  - id: only\n    chain: scout", "## only\nLook around."),
			"/x/p.md",
		);
		assert.deepEqual(parsed.steps[0]?.agents, ["scout"]);
	});

	test("keeps the steps in the declared order", () => {
		const parsed = parsePipeline(
			pipeline(
				"name: p\nsteps:\n  - id: c\n    chain: a\n  - id: b\n    chain: a\n  - id: a\n    chain: a",
				"## a\nx\n\n## b\ny\n\n## c\nz",
			),
			"/x/p.md",
		);
		assert.deepEqual(
			parsed.steps.map((step) => step.id),
			["c", "b", "a"],
		);
		assert.deepEqual(
			parsed.steps.map((step) => step.prompt),
			["z", "y", "x"],
		);
	});

	test("every combinator is spellable", () => {
		for (const kind of STEP_KINDS) {
			const extra: Record<string, string> = {
				route: "\n    destinations: [a, b]",
				orchestrate: "\n    workers: [a]",
				deliver: "\n    workers: [a]\n    reviewer: r",
				fanOut: "\n    tasks: [one, two]",
			};
			const agents = kind === "pair" ? "[w, r]" : "a";
			const parsed = parsePipeline(
				pipeline(`name: p\nsteps:\n  - id: s\n    ${kind}: ${agents}${extra[kind] ?? ""}`, "## s\ngo"),
				"/x/p.md",
			);
			assert.equal(parsed.steps[0]?.kind, kind);
		}
	});
});

describe("parsePipeline rejects", () => {
	const rejects = (content: string, message: RegExp) => {
		assert.throws(() => parsePipeline(content, "/x/p.md"), message);
	};

	test("a file with no name or no steps", () => {
		rejects(pipeline("description: nameless", "## s\ngo"), /needs a "name"/);
		rejects(pipeline("name: p", "## s\ngo"), /non-empty "steps"/);
		rejects(pipeline("name: p\nsteps: []", ""), /non-empty "steps"/);
	});

	test("a step naming no combinator, or several", () => {
		rejects(pipeline("name: p\nsteps:\n  - id: s\n    agent: a", "## s\ngo"), /names no combinator/);
		rejects(pipeline("name: p\nsteps:\n  - id: s\n    chain: a\n    pair: [a, b]", "## s\ngo"), /names several/);
	});

	// A renamed id on one side only is silent otherwise: the step still runs,
	// with no instruction at all.
	test("an id and a section that no longer match, in either direction", () => {
		rejects(pipeline("name: p\nsteps:\n  - id: s\n    chain: a", "## typo\ngo"), /step "s" has no "## s" section/);
		rejects(
			pipeline("name: p\nsteps:\n  - id: s\n    chain: a", "## s\ngo\n\n## ghost\ngo"),
			/section "## ghost" matches no step/,
		);
	});

	test("a duplicate id, which would make two steps share one section", () => {
		rejects(
			pipeline("name: p\nsteps:\n  - id: s\n    chain: a\n  - id: s\n    chain: b", "## s\ngo"),
			/duplicate step id "s"/,
		);
	});

	test("a combinator missing what its signature requires", () => {
		rejects(pipeline("name: p\nsteps:\n  - id: s\n    pair: w", "## s\ngo"), /pair takes exactly 2 agents/);
		rejects(pipeline("name: p\nsteps:\n  - id: s\n    reduce: [a, b]", "## s\ngo"), /reduce takes exactly 1 agent/);
		rejects(
			pipeline("name: p\nsteps:\n  - id: s\n    route: r\n    destinations: [only]", "## s\ngo"),
			/at least two "destinations"/,
		);
		rejects(pipeline("name: p\nsteps:\n  - id: s\n    orchestrate: p", "## s\ngo"), /needs "workers"/);
		rejects(pipeline("name: p\nsteps:\n  - id: s\n    deliver: p\n    workers: [w]", "## s\ngo"), /needs a "reviewer"/);
	});

	// A fan-out whose branches come from the previous step is what orchestrate
	// is - which is why no templating syntax is needed anywhere.
	test("a fanOut with no literal tasks, or a mismatched roster", () => {
		rejects(pipeline("name: p\nsteps:\n  - id: s\n    fanOut: a", "## s\ngo"), /needs literal "tasks"/);
		rejects(
			pipeline("name: p\nsteps:\n  - id: s\n    fanOut: [a, b]\n    tasks: [one, two, three]", "## s\ngo"),
			/one agent for every branch, or 3/,
		);
	});

	test("a guard that is not a positive number, and an unknown lifetime", () => {
		rejects(
			pipeline("name: p\nsteps:\n  - id: s\n    loop: a\n    maxIterations: 0", "## s\ngo"),
			/maxIterations must be a positive number/,
		);
		rejects(
			pipeline("name: p\nsteps:\n  - id: s\n    loop: a\n    maxIterations: soon", "## s\ngo"),
			/maxIterations must be a positive number/,
		);
		rejects(
			pipeline("name: p\nsteps:\n  - id: s\n    chain: a\n    lifetime: forever", "## s\ngo"),
			/unknown lifetime "forever"/,
		);
	});

	test("an agent slot that is not text", () => {
		rejects(pipeline("name: p\nsteps:\n  - id: s\n    chain: [a, 7]", "## s\ngo"), /must be text, got 7/);
	});

	test("naming the file it came from, so the error is actionable", () => {
		assert.throws(() => parsePipeline(pipeline("steps: []", ""), "/x/build.md"), /^Error: \/x\/build\.md: /);
	});
});

describe("parsePipeline tolerates", () => {
	// A single-agent loop refining its own output is legitimate, and
	// maxIterations already makes it terminate.
	test("a loop over a single agent", () => {
		const parsed = parsePipeline(
			pipeline("name: p\nsteps:\n  - id: s\n    loop: writer\n    until: DONE", "## s\nRefine."),
			"/x/p.md",
		);
		assert.deepEqual(parsed.steps[0]?.agents, ["writer"]);
	});

	test("a flag written as YAML text rather than as a boolean", () => {
		const parsed = parsePipeline(
			pipeline('name: p\nsteps:\n  - id: s\n    chain: a\n    openInHerdr: "true"', "## s\ngo"),
			"/x/p.md",
		);
		assert.equal(parsed.steps[0]?.openInHerdr, true);
	});

	test("prose containing a hash that is not a heading", () => {
		const parsed = parsePipeline(
			pipeline("name: p\nsteps:\n  - id: s\n    chain: a", "## s\nRun `npm test`.\n### details\nSee #12."),
			"/x/p.md",
		);
		assert.equal(parsed.steps[0]?.prompt, "Run `npm test`.\n### details\nSee #12.");
	});
});
