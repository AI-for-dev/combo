/**
 * The run directory: the journal a run appends each fact to, read back with
 * a torn last line ignored, and the snapshot of what its validation read,
 * which re-reads to the same check. With no run directory, nothing touches
 * the disk.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { SubagentEvent } from "../src/events.ts";
import { gitPort } from "../src/git/index.ts";
import { checkFlow, checkRun, dryRunFlow, loadFlowCatalogue, readJournal, readSnapshot, runFlow, type JournalEntry } from "../src/flow/index.ts";
import { ENTRY_TYPES, fileJournal, JOURNAL_FILE } from "../src/flow/run/journal.ts";
import { emptyUsage } from "../src/usage.ts";
import { bashCheck } from "../src/verify.ts";
import { checked, flowSpawn, launched } from "./fixtures/flow.ts";
import { plainDirectory, repository, write } from "./fixtures/repo.ts";

/** A fresh directory, its path as the filesystem resolves it. */
const directory = () => fs.realpathSync(plainDirectory());

/** Each entry as `type path`, or `type` for one with no path. */
const facts = (journal: readonly JournalEntry[]) => journal.map((entry) => ("path" in entry && entry.path !== undefined ? `${entry.type} ${entry.path}` : "ledger" in entry ? `${entry.type} ${entry.ledger}` : entry.type));

describe("the journal", () => {
	const ENTRIES: JournalEntry[] = [
		{ type: "visit_end", path: "fix#1/code", ok: true, output: "done", agent: "scout", model: "p/m", wallMs: 3, usage: emptyUsage() },
		{ type: "carry", path: "fix#2", value: ["b"] },
		{ type: "map_items", path: "fix#1/work", items: ["a", "b"] },
		{ type: "obligation_raised", ledger: "fix", obligation: { id: "o1", openedBy: "reviewer", text: "more", openedAt: 1 } },
		{ type: "obligation_closed", ledger: "fix", id: "o1", closure: { how: "addressed", at: 2 } },
		{ type: "copy_opened", path: "both/a", dir: "/tmp/copy", branch: "combo/copy-a" },
		{ type: "copy_landed", path: "both/a", landed: false, refused: "conflict" },
		{ type: "branch_opened", branch: "combo/x" },
		{ type: "run_end", ok: false, error: { kind: "child", message: "fix#1/code: provider: down" }, path: "fix#1/code", usage: emptyUsage() },
	];

	test("reads back every kind of entry as it was appended, in order", () => {
		assert.deepEqual(ENTRIES.map(({ type }) => type), [...ENTRY_TYPES]);
		const runDir = directory();
		const journal = fileJournal(runDir);
		for (const entry of ENTRIES) journal.append(entry);
		assert.deepEqual(readJournal(runDir), ENTRIES);
	});

	test("ignores a torn last line, is empty when nothing was written, and refuses a line that is no entry", () => {
		const runDir = directory();
		assert.deepEqual(readJournal(runDir), []);
		const journal = fileJournal(runDir);
		for (const entry of ENTRIES.slice(0, 2)) journal.append(entry);
		fs.appendFileSync(path.join(runDir, JOURNAL_FILE), '{"type":"visit_end","pa');
		assert.deepEqual(readJournal(runDir), ENTRIES.slice(0, 2));
		fs.writeFileSync(path.join(runDir, JOURNAL_FILE), `{"type":"visit_e\n${JSON.stringify(ENTRIES[0])}\n`);
		assert.throws(() => readJournal(runDir), /journal\.jsonl:1 is not JSON/);
		fs.writeFileSync(path.join(runDir, JOURNAL_FILE), '{"type":"lunch"}\n');
		assert.throws(() => readJournal(runDir), /journal\.jsonl:1 is not a journal entry/);
	});
});

describe("a dry run's journal", () => {
	test("holds each carry, frozen list and obligation where it happened, and the run's end last", async () => {
		const flow = checked(
			`  - id: plan
    agent: planner
    output: { todo: [string] }
  - id: fix
    loop: audit.output.approved
    max: 2
    ledger: fix
    carry: { first: plan.output.todo, next: plan.output.todo }
    do:
      - id: work
        map-from: fix.carry
        max: 3
        do:
          - id: code
            agent: scout
      - id: audit
        agent: reviewer
        verdict: fix`,
			{ plan: "Plan.", code: "Code.", audit: "Audit." },
		);
		const run = await dryRunFlow(flow, "x", {
			plan: { todo: ["a"] },
			"fix/work/code": "done",
			"fix/audit": [{ approved: false, raised: ["more"] }, { approved: true, resolved: [{ id: "o1", how: "addressed" }] }],
		});
		assert.ok(run.ok && "journal" in run, JSON.stringify(run));
		assert.deepEqual(facts(run.journal), [
			"visit_end plan",
			"carry fix#1",
			"map_items fix#1/work",
			"visit_end fix#1/work[1]/code",
			"visit_end fix#1/work",
			"obligation_raised fix",
			"visit_end fix#1/audit",
			"carry fix#2",
			"map_items fix#2/work",
			"visit_end fix#2/work[1]/code",
			"visit_end fix#2/work",
			"obligation_closed fix",
			"visit_end fix#2/audit",
			"visit_end fix",
			"run_end",
		]);
		assert.deepEqual(run.journal[1], { type: "carry", path: "fix#1", value: ["a"] });
		assert.deepEqual(run.journal.at(-1), { type: "run_end", ok: true, output: run.output, usage: run.usage });
	});

	test("opens and lands each copy of a `copies: true` block as a fact alone", async () => {
		const flow = checked("  - id: both\n    copies: true\n    parallel:\n      a:\n        - id: x\n          agent: scout\n      b:\n        - id: y\n          agent: scout", { x: "X.", y: "Y." });
		const run = await dryRunFlow(flow, "x", { "both/x": "x", "both/y": "y" });
		assert.ok("journal" in run);
		const copies = run.journal.filter((entry) => entry.type.startsWith("copy_"));
		assert.deepEqual(copies, [
			{ type: "copy_opened", path: "both/a" },
			{ type: "copy_opened", path: "both/b" },
			{ type: "copy_landed", path: "both/a", landed: true },
			{ type: "copy_landed", path: "both/b", landed: true },
		]);
	});
});

describe("a run given a run directory", () => {
	test("appends each fact to its journal, a visit's being the `visit_end` it told", async () => {
		const cwd = repository({ ".pi/checks/a.sh": "echo a > a.txt", ".pi/checks/b.sh": "echo b > b.txt" });
		const branch = (name: string) => `      ${name}:\n        - id: w${name}\n          check: .pi/checks/${name}.sh\n`;
		const flow = checked(`  - id: m\n    agent: scout\n  - id: both\n    copies: true\n    parallel:\n${branch("a")}${branch("b")}  - id: c\n    commit: m`, { m: "Write the message." });
		const runDir = path.join(directory(), "run");
		const events: SubagentEvent[] = [];
		const run = await launched(flow, { cwd, ports: { git: gitPort(), check: bashCheck() } });
		const result = await runFlow(run, "x", { spawn: flowSpawn([[{ text: "Add a and b" }]]).spawn, runDir, onEvent: (event) => events.push(event) });
		assert.ok(result.ok, JSON.stringify(result));
		const journal = readJournal(runDir);
		assert.deepEqual(
			journal.filter((entry) => entry.type === "visit_end"),
			events.filter((event) => event.type === "visit_end"),
		);
		const opened = journal.filter((entry) => entry.type === "copy_opened");
		assert.deepEqual(opened.map((entry) => [entry.path, typeof entry.dir, typeof entry.branch]).sort(), [["both/a", "string", "string"], ["both/b", "string", "string"]]);
		assert.deepEqual(journal.filter((entry) => entry.type === "copy_landed"), [{ type: "copy_landed", path: "both/a", landed: true }, { type: "copy_landed", path: "both/b", landed: true }]);
		assert.deepEqual(facts(journal).slice(-4), ["visit_end both", "branch_opened", "visit_end c", "run_end"]);
		assert.deepEqual(journal.find((entry) => entry.type === "branch_opened"), { type: "branch_opened", branch: "combo/x" });
	});

	test("refuses a directory that already holds a run", async () => {
		const flow = checked("  - id: look\n    agent: scout", { look: "Look." });
		const runDir = directory();
		const run = await launched(flow, { cwd: directory() });
		await runFlow(run, "x", { spawn: flowSpawn([[{ text: "seen" }]]).spawn, runDir });
		await assert.rejects(runFlow(run, "x", { spawn: flowSpawn([[{ text: "seen" }]]).spawn, runDir }), /EEXIST/);
	});

	test("given none, touches no disk", async () => {
		const cwd = directory();
		const flow = checked("  - id: look\n    agent: scout", { look: "Look." });
		const result = await runFlow(await launched(flow, { cwd }), "x", { spawn: flowSpawn([[{ text: "seen" }]]).spawn });
		assert.ok(result.ok);
		assert.deepEqual(fs.readdirSync(cwd), []);
	});
});

describe("the snapshot", () => {
	/** A project whose flow `main` calls `sub`, names two of three agents, one with a skill, and runs a check. */
	function project(): string {
		const cwd = directory();
		const flow = (name: string, nodes: string, body: string) => `---\nname: ${name}\ndescription: d\ninput: string\nnodes:\n${nodes}\n---\n${body}`;
		const agent = (name: string, more = "") => `---\nname: ${name}\ndescription: the ${name}\n${more}---\nYou are the ${name}.\n`;
		write(cwd, {
			".pi/flows/main.md": flow("main", "  - id: look\n    agent: scout\n  - id: sub\n    flow: sub\n    input: look.output\n  - id: tests\n    check: .pi/checks/t.sh", "## look\nLook."),
			".pi/flows/sub.md": flow("sub", "  - id: plan\n    agent: planner", "## plan\nPlan."),
			".pi/flows/idle.md": flow("idle", "  - id: rest\n    agent: idle", "## rest\nRest."),
			".pi/agents/scout.md": agent("scout", "tools: read\nskills: probe\n"),
			".pi/agents/scout/skills/probe/SKILL.md": "---\nname: probe\ndescription: How to probe.\n---\nProbe, then read notes.md.\n",
			".pi/agents/scout/skills/probe/notes.md": "Notes.\n",
			".pi/agents/planner.md": agent("planner"),
			".pi/agents/idle.md": agent("idle"),
			".pi/checks/t.sh": "exit 0\n",
		});
		return cwd;
	}

	test("holds what validation read, the input and the settings, and re-reads to the same check", async () => {
		const cwd = project();
		const catalogue = loadFlowCatalogue({ cwd, scope: "project" });
		const checkedFlow = checkFlow("main", catalogue);
		assert.ok(checkedFlow.ok, JSON.stringify(!checkedFlow.ok && checkedFlow.faults));
		const run = await checkRun(checkedFlow.flow, { cwd, ports: { check: bashCheck() }, somebodyThere: false });
		assert.ok(run.ok);
		const runDir = path.join(directory(), "run");
		const result = await runFlow(run.run, "x", { spawn: flowSpawn([[{ text: "seen" }], [{ text: "planned" }]]).spawn, runDir, model: "p/m" });
		assert.ok(result.ok, JSON.stringify(result));

		const snapshot = readSnapshot(runDir);
		assert.deepEqual([snapshot.flow, snapshot.input, snapshot.settings], ["main", "x", { cwd, somebodyThere: false, model: "p/m" }]);
		assert.deepEqual(snapshot.catalogue.flows.map(({ name }) => name), ["main", "sub"]);
		assert.deepEqual(snapshot.catalogue.agents.map(({ name }) => name), ["scout", "planner"]);
		assert.deepEqual([...snapshot.scripts], [[".pi/checks/t.sh", "exit 0\n"]]);
		assert.equal(fs.readFileSync(path.join(runDir, "agents/scout/skills/probe/notes.md"), "utf-8"), "Notes.\n");

		// The disk changing after the start changes nothing a snapshot re-reads.
		write(cwd, { ".pi/flows/sub.md": "broken", ".pi/agents/scout/skills/probe/SKILL.md": "gone" });
		const again = checkFlow(snapshot.flow, snapshot.catalogue);
		assert.ok(again.ok, JSON.stringify(!again.ok && again.faults));
		// Read back, an agent and its skills live in the snapshot: that is the only difference.
		const where = (value: unknown) => JSON.stringify(value).replaceAll(`${cwd}/.pi/`, "").replaceAll(`${runDir}/`, "");
		assert.equal(where(again.flow), where(checkedFlow.flow));
		assert.equal(again.flow.sources.agents[0]?.skills[0]?.filePath, path.join(runDir, "agents/scout/skills/probe/SKILL.md"));
	});
});
