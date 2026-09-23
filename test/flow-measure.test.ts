/**
 * Measuring a flow run in its run directory: each subagent's transcript under
 * its home, and the `usage.json` a `measuredRun` beside it leaves, with the
 * visits, the nodes and every life of the run, one killed before it wrote
 * its own included.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { Agent } from "../src/agent.ts";
import { checkFlow, readJournal, resumeFlow, runFlow, type CheckedFlow } from "../src/flow/index.ts";
import { JOURNAL_FILE } from "../src/flow/run/journal.ts";
import { Transcripts } from "../src/flow/run/transcripts.ts";
import { measuredRun, type UsageReport } from "../src/measure/index.ts";
import type { Subagent } from "../src/subagent.ts";
import type { SpawnFn } from "../src/workflows/options.ts";
import { agent, AGENTS, catalogueOf, flowSpawn, flowText, launched, type FlowTurn } from "./fixtures/flow.ts";
import { plainDirectory } from "./fixtures/repo.ts";

const SPENT = { tokens: { input: 100, output: 10 }, cost: 0.01 };

/** A turn that says `text`, and costs {@link SPENT}. */
const said = (text: string, more: Partial<FlowTurn> = {}): FlowTurn => ({ text, ...SPENT, ...more });

/** The flow `f` of `nodes`, checked against the shipped fixtures and `lead`, who delegates. */
function flowOf(nodes: string, sections: Record<string, string>): CheckedFlow {
	const catalogue = catalogueOf({ f: flowText(nodes, sections) });
	const found = checkFlow("f", { ...catalogue, agents: [...AGENTS, agent("lead", ["read", "subagent"])] });
	assert.ok(found.ok, JSON.stringify(!found.ok && found.faults));
	return found.flow;
}

/** Every transcript under `dir`, relative, sorted: what a person opens. */
function transcripts(dir: string): string[] {
	return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((file) => /\.(jsonl|html)$/.test(file) && !/^(journal|events|main)/.test(path.basename(file))).sort();
}

const usageIn = (dir: string): UsageReport => JSON.parse(fs.readFileSync(path.join(dir, "usage.json"), "utf-8"));

describe("a measured flow run", () => {
	const LAYOUT = flowOf(
		`  - id: plan
    agent: planner
    memory: flow
  - id: fix
    loop: audit.output.approved
    max: 2
    do:
      - id: code
        agent: scout
        memory: fix
      - id: audit
        agent: reviewer
        output: { approved: boolean }
  - id: split
    agent: lead
  - id: sum
    agent: planner
    memory: flow`,
		{ plan: "Plan.", code: "Code.", audit: "Audit.", split: "Split.", sum: "Sum." },
	);

	test("leaves one transcript per subagent under its home, and its delegates in `<parent>.children/`", async () => {
		const runDir = path.join(fs.realpathSync(plainDirectory()), "run");
		const fake = flowSpawn({
			planner: [[said("planned"), said("summed")]],
			scout: [[said("c1"), said("c2")], [said("a")], [said("b")]],
			reviewer: [[said("", { submit: { approved: false } })], [said("", { submit: { approved: true } })]],
			lead: [[said("split", { subagent: { agent: "scout", tasks: ["a", "b"] } })]],
		});
		const run = measuredRun({ dir: runDir, record: true });
		const result = await runFlow(await launched(LAYOUT), "x", { spawn: fake.spawn, onEvent: run.onEvent, runDir });
		assert.ok(result.ok, JSON.stringify(result));
		const report = run.finish();

		const children = fs.readdirSync(path.join(runDir, "split/lead.children")).filter((file) => file.endsWith(".jsonl"));
		assert.equal(children.length, 2);
		assert.ok(children.every((file) => /^scout-\d+\.jsonl$/.test(file)), children.join());
		assert.deepEqual(transcripts(runDir), [
			"fix#1/audit/reviewer.html",
			"fix#1/audit/reviewer.jsonl",
			"fix#2/audit/reviewer.html",
			"fix#2/audit/reviewer.jsonl",
			"fix/scout.html",
			"fix/scout.jsonl",
			"planner.html",
			"planner.jsonl",
			"split/lead.children/" + children[0]?.replace(".jsonl", ".html"),
			"split/lead.children/" + children[0],
			"split/lead.children/" + children[1]?.replace(".jsonl", ".html"),
			"split/lead.children/" + children[1],
			"split/lead.html",
			"split/lead.jsonl",
		].sort());
		// One session, one replayable file, whatever the visits it served.
		assert.equal(fs.readFileSync(path.join(runDir, "fix/scout.jsonl"), "utf-8").trimEnd().split("\n").length, 2);

		assert.deepEqual(usageIn(runDir), JSON.parse(JSON.stringify(report)));
		assert.deepEqual(
			report.visits?.map(({ path, node, kind, life }) => `${path} ${node} ${kind} ${life}`),
			["plan plan agent 1", "fix fix loop 1", "fix#1/code fix/code agent 1", "fix#1/audit fix/audit agent 1", "fix#2/code fix/code agent 1", "fix#2/audit fix/audit agent 1", "split split agent 1", "sum sum agent 1"],
		);
		assert.deepEqual(
			report.nodes?.map(({ node, visits, usage }) => `${node} ${visits} ${usage.input}`),
			["plan 1 100", "fix 1 400", "fix/code 2 200", "fix/audit 2 200", "split 1 100", "sum 1 100"],
		);
		const bySubagent = report.subagents.map(({ agent, home, life, visits, parentId }) => ({ agent, home, life, visits, child: parentId !== undefined }));
		assert.deepEqual(bySubagent, [
			{ agent: "planner", home: "", life: 1, visits: ["plan", "sum"], child: false },
			{ agent: "scout", home: "fix", life: 1, visits: ["fix#1/code", "fix#2/code"], child: false },
			{ agent: "reviewer", home: "fix#1/audit", life: 1, visits: ["fix#1/audit"], child: false },
			{ agent: "reviewer", home: "fix#2/audit", life: 1, visits: ["fix#2/audit"], child: false },
			{ agent: "lead", home: "split", life: 1, visits: ["split"], child: false },
			{ agent: "scout", home: "split/lead.children", life: 1, visits: [], child: true },
			{ agent: "scout", home: "split/lead.children", life: 1, visits: [], child: true },
		]);
		// The delegates' turns are theirs, not the visit's: nine turns, of which seven are the visits'.
		assert.deepEqual(
			report.lives?.map(({ end, partial, usage }) => [end, partial, usage.input]),
			[["ok", undefined, 900]],
		);
		assert.equal(report.total.input, 900);
		assert.equal(report.total.wallMs, report.lives?.[0]?.wallMs);
	});

	test("without a run directory touches no disk", async () => {
		const fake = flowSpawn([[said("seen")]]);
		const result = await runFlow(await launched(flowOf("  - id: look\n    agent: scout", { look: "Look." })), "x", { spawn: fake.spawn });
		assert.ok(result.ok);
		assert.deepEqual(fake.requested.map(({ options }) => options.sessionDir), [undefined]);
	});

	test("counts every life of a resumed run, rebuilding the one killed before it wrote its own", async () => {
		const flow = flowOf("  - id: look\n    agent: scout\n  - id: more\n    agent: planner\n  - id: last\n    agent: synthesiser", { look: "Look.", more: "More.", last: "Last." });
		const cwd = fs.realpathSync(plainDirectory());
		const runDir = path.join(cwd, "run");
		const main = path.join(cwd, "main-session.jsonl");
		fs.writeFileSync(main, '{"type":"session"}\n');

		// Life 1 is killed before `more` ended: its journal stops there, and it never finished its measurement.
		const first = measuredRun({ dir: runDir, record: true });
		await runFlow(await launched(flow, { cwd }), "x", { spawn: flowSpawn([[said("seen")], [said("more")], [said("last")]]).spawn, onEvent: first.onEvent, runDir });
		const journal = readJournal(runDir);
		const cut = journal.findIndex((entry) => entry.type === "visit_end" && entry.path === "more");
		fs.writeFileSync(path.join(runDir, JOURNAL_FILE), journal.slice(0, cut).map((entry) => `${JSON.stringify(entry)}\n`).join(""));

		// Life 2 fails at `last`; life 3 replays it.
		for (const turns of [[[said("more again")], [said("down", { stopReason: "error" })]], [[said("last again")]]]) {
			const life = measuredRun({ dir: runDir, record: true, mainSessionFile: main });
			await resumeFlow(runDir, { ports: {}, somebodyThere: false, spawn: flowSpawn(turns).spawn, onEvent: life.onEvent });
			life.finish();
		}

		const report = usageIn(runDir);
		assert.deepEqual(
			report.lives?.map(({ end, partial, usage }) => [end, partial ?? false, usage.input]),
			[
				["interrupted", true, 100],
				["failed", false, 200],
				["ok", false, 100],
			],
		);
		const lives = report.lives ?? [];
		for (const key of ["input", "output", "cost", "wallMs"] as const) assert.equal(report.total[key], lives.reduce((sum, life) => sum + life.usage[key], 0), key);
		assert.equal(report.wallMs, report.total.wallMs);
		// `last` failed in life 2 and ran again in life 3: it was paid twice, and is listed twice.
		assert.deepEqual(
			report.visits?.map(({ path, life, ok }) => `${path} ${life} ${ok}`),
			["look 1 true", "more 2 true", "last 2 false", "last 3 true"],
		);
		assert.deepEqual(
			report.subagents.map(({ home, life }) => `${home} ${life}`),
			["more 2", "last 2", "last 3"],
		);
		assert.deepEqual(transcripts(runDir), ["last/synthesiser.html", "last/synthesiser.jsonl", "last/synthesiser~2.html", "last/synthesiser~2.jsonl", "last/synthesiser~3.html", "last/synthesiser~3.jsonl", "look/scout.html", "look/scout.jsonl", "more/planner.html", "more/planner.jsonl", "more/planner~2.html", "more/planner~2.jsonl"]);
		const kept = fs.readdirSync(runDir).filter((file) => /^(events|main)/.test(file));
		assert.deepEqual(kept.sort(), ["events.jsonl", "events~2.jsonl", "events~3.jsonl", "main.jsonl", "main~2.jsonl"]);
	});
});

describe("transcripts", () => {
	test("put a delegate's own delegates under its files, recursively", async () => {
		const runDir = fs.realpathSync(plainDirectory());
		const asked: (string | undefined)[] = [];
		let n = 0;
		const spawn: SpawnFn = async (one: Agent, options) => {
			asked.push(path.relative(runDir, path.join(options.exportDir as string, options.exportName ?? "")));
			return { id: `${one.name}#${++n}` } as Subagent;
		};
		const placed = new Transcripts(runDir);
		const coder = await placed.atHome(spawn, agent("coder"), {}, "work[1]");
		const scout = await placed.children(spawn)(agent("scout"), { parentId: coder.id });
		await placed.children(spawn)(agent("scout"), { parentId: scout.id });
		await placed.atHome(spawn, agent("coder"), {}, "work[1]");
		assert.deepEqual(asked, ["work[1]/coder", "work[1]/coder.children", "work[1]/coder.children/scout-2.children", "work[1]/coder~2"]);
	});
});
