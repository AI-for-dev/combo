/**
 * What a checked flow shows before it runs: its bounds, the worst case per
 * node and in total with sub-flows unrolled, its plan as text, and its
 * Mermaid diagram. All three are pure, so each is asserted whole.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mermaidOf, planOf, showBound, showPlan, type Bound, type CheckedFlow } from "../src/flow/index.ts";
import { checkedIn, flowText } from "./fixtures/flow.ts";

const MINUTE = 60_000;

/** `look`, one retried agent turn, in a flow `g` whose own `timeout:` is `head`'s. */
const g = (head = "input: string") => flowText("  - id: look\n    agent: scout\n    retry: 1", { look: "L." }, head, "g");

/** A loop of three around a `map` of four, two at a time, and a parallel whose one branch calls `g` and whose other asks. */
const NESTED = `  - id: plan
    agent: planner
    reads: [input]
    output: { tasks: [string], ready: boolean }
  - id: rounds
    loop: review.output.approved
    max: 3
    ledger: rounds
    do:
      - id: work
        map-from: plan.output.tasks
        max: 4
        concurrency: 2
        do:
          - id: act
            agent: scout
            reads: [item]
            timeout: 90s
      - id: both
        parallel:
          one:
            - id: spec
              flow: g
              input: input
          two:
            - id: sure
              ask: "Go on?"
              confirm: true
      - id: review
        agent: reviewer
        verdict: rounds
        on-fail: continue`;

const nested = (head?: string, callee = g("input: string\ntimeout: 10m")) => checkedIn("f", { f: flowText(NESTED, { plan: "P.", act: "A.", review: "R." }, head), g: callee });

/** The choice and the literal map the renderings draw. */
const SMALL = `  - id: plan
    agent: planner
    output: { ready: boolean }
  - id: gate
    choice:
      - when: plan.output.ready && "a" != "<b>"
        do:
          - id: go
            agent-from: plan.output.who
            among: [scout, reviewer]
    default: []
  - id: each
    map: [a, b]
    do:
      - id: check_it
        check: scripts/ok.sh
        timeout: 2m
      - id: save
        commit: plan.output.message
        on-fail: continue`;

const small = (): CheckedFlow =>
	checkedIn("f", { f: flowText(SMALL.replace("output: { ready: boolean }", "output: { ready: boolean, who: scout | reviewer, message: string }"), { plan: "P.", go: "G." }, "input: string\ntimeout: 5m") });

const bound = (turns: number, minutes: number, waits = false): Bound => ({ turns, ms: minutes * MINUTE, waits });

describe("the bounds of a checked flow", () => {
	test("multiply each agent node's attempts by every loop and map around it, through the calls", () => {
		const { bounds } = nested();
		assert.deepEqual(Object.fromEntries(bounds.nodes), {
			plan: bound(1, 30),
			"rounds/work/act": bound(12, 9),
			"rounds/work": bound(12, 9),
			"rounds/both/spec/look": bound(6, 60),
			"rounds/both/spec": bound(6, 60),
			"rounds/both/sure": bound(0, 0, true),
			"rounds/both": bound(6, 60, true),
			"rounds/review": bound(3, 90),
			rounds: bound(21, 159, true),
		});
		assert.deepEqual(bounds.total, bound(22, 189, true));
	});

	test("give a callee with no `timeout:` its caller's, and its own when it has one", () => {
		assert.deepEqual(nested("input: string\ntimeout: 5m", g()).bounds.nodes.get("rounds/both/spec/look"), bound(6, 30), "2 attempts of 5m, 3 times");
		assert.deepEqual(nested("input: string\ntimeout: 5m").bounds.nodes.get("rounds/both/spec/look"), bound(6, 60), "the callee's 10m wins");
	});

	test("take the worst case of a choice, and a literal list as the bound of its map", () => {
		const { bounds } = small();
		assert.deepEqual([bounds.nodes.get("gate"), bounds.nodes.get("each"), bounds.total], [bound(1, 5), bound(0, 4), bound(2, 14)]);
	});

	test("show turns and time, and a person's answer an ask with no `timeout:` waits for", () => {
		assert.equal(showBound(bound(22, 189, true)), "≤ 22 turns · ≤ 3h9m + a person's answer");
		assert.equal(showBound(bound(1, 1.5)), "≤ 1 turn · ≤ 1m30s");
		assert.equal(showBound(bound(0, 0, true)), "a person's answer");
		assert.equal(showBound(bound(0, 0)), "");
	});
});

describe("the plan of a checked flow", () => {
	test("is each node resolved, under its visit path, with its bound", () => {
		assert.equal(
			showPlan(planOf(nested())),
			[
				"f · flows/f.md · input string · ≤ 22 turns · ≤ 3h9m + a person's answer",
				"○ plan · agent planner (agents/planner.md) · reads input · output { tasks: [string], ready: boolean } · timeout 30m by default · ≤ 1 turn · ≤ 30m",
				"○ rounds · loop until review.output.approved · max 3 · ledger · ≤ 21 turns · ≤ 2h39m + a person's answer",
				"  ○ rounds#n/work · map from plan.output.tasks, max 4 · concurrency 2 · ≤ 12 turns · ≤ 9m",
				"    ○ rounds#n/work[i]/act · agent scout (agents/scout.md) · reads item · timeout 1m30s · ≤ 12 turns · ≤ 9m",
				"  ○ rounds#n/both · parallel · ≤ 6 turns · ≤ 1h + a person's answer",
				"    ○ rounds#n/both/one",
				"      ○ rounds#n/both/one/spec · flow g (flows/g.md) · input input · ≤ 6 turns · ≤ 1h",
				"    ○ rounds#n/both/two",
				'      ○ rounds#n/both/two/sure · ask "Go on?" · confirm · a person\'s answer',
				"  ○ rounds#n/review · agent reviewer (agents/reviewer.md) · verdict to rounds · timeout 30m by default · on-fail continue · ≤ 3 turns · ≤ 1h30m",
			].join("\n"),
		);
	});

	test("says where each agent and each turn's bound came from, and each case of a choice", () => {
		assert.equal(
			showPlan(planOf(small())),
			[
				"f · flows/f.md · input string · timeout 5m · ≤ 2 turns · ≤ 14m",
				"○ plan · agent planner (agents/planner.md) · output { ready: boolean, who: scout | reviewer, message: string } · timeout 5m from the flow · ≤ 1 turn · ≤ 5m",
				"○ gate · choice of 1 case · ≤ 1 turn · ≤ 5m",
				'  ○ case 1 · when plan.output.ready && "a" != "<b>"',
				"    ○ gate/go · agent from plan.output.who: scout (agents/scout.md), reviewer (agents/reviewer.md) · timeout 5m from the flow · ≤ 1 turn · ≤ 5m",
				"  ○ default",
				"○ each · map a, b · ≤ 4m",
				"  ○ each[i]/check_it · check scripts/ok.sh · timeout 2m · ≤ 4m",
				"  ○ each[i]/save · commit plan.output.message · on-fail continue",
			].join("\n"),
		);
	});

	test("keeps the tree a run fills: kinds, ids and paths line by line", () => {
		const [, rounds] = planOf(nested()).lines;
		assert.deepEqual(
			rounds?.lines.map((line) => [line.kind, line.id, line.path, line.lines.map((one) => one.path)]),
			[
				["map", "work", "rounds#n/work", ["rounds#n/work[i]/act"]],
				["parallel", "both", "rounds#n/both", ["rounds#n/both/one", "rounds#n/both/two"]],
				["agent", "review", "rounds#n/review", []],
			],
		);
	});
});

describe("the Mermaid diagram of a checked flow", () => {
	test("draws sequences as arrows, blocks as subgraphs, a call as one box, and the loop's way back", () => {
		assert.equal(
			mermaidOf(nested()),
			[
				"flowchart TD",
				'  n1["plan<br/>agent planner"]',
				'  subgraph n2["loop rounds · max 3"]',
				'    subgraph n3["map work · max 4"]',
				'      n4["act<br/>agent scout"]',
				"    end",
				'    subgraph n5["parallel both"]',
				'      subgraph n6["branch one"]',
				'        n7[["spec<br/>flow g<br/>flows/g.md<br/>input: input"]]',
				"      end",
				'      subgraph n8["branch two"]',
				'        n9["sure<br/>ask"]',
				"      end",
				"    end",
				'    n10["review<br/>agent reviewer<br/>on-fail: continue"]',
				"    n3 --> n5",
				"    n5 --> n10",
				'    n10 -.->|"until review.output.approved"| n3',
				"  end",
				"  n1 --> n2",
			].join("\n"),
		);
	});

	test("writes each case's condition on its arrow, escaped, and an empty default as nothing", () => {
		assert.equal(
			mermaidOf(small()),
			[
				"flowchart TD",
				'  n1["plan<br/>agent planner"]',
				'  subgraph n2["choice gate"]',
				'    n3{"case"}',
				'    n4["go<br/>agent scout or reviewer"]',
				'    n3 -->|"plan.output.ready #38;#38; #34;a#34; != #34;#60;b#62;#34;"| n4',
				'    n5(("nothing"))',
				'    n3 -->|"default"| n5',
				"  end",
				'  subgraph n6["map each · 2 items"]',
				'    n7["check_it<br/>check scripts/ok.sh"]',
				'    n8["save<br/>commit<br/>on-fail: continue"]',
				"    n7 --> n8",
				"  end",
				"  n1 --> n2",
				"  n2 --> n6",
			].join("\n"),
		);
	});
});

describe("both renderings", () => {
	test("are the same text for the same flow, checked twice", () => {
		for (const flow of [nested, small]) {
			assert.equal(showPlan(planOf(flow())), showPlan(planOf(flow())));
			assert.equal(mermaidOf(flow()), mermaidOf(flow()));
		}
	});
});
