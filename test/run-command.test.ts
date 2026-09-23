/**
 * `/run`, on real run directories and fake sessions: what the person is told
 * before anything runs, what lands in the conversation after, and how
 * `/run resume` finds a run and says where it picks up.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { RESULT_MESSAGE, type ResultDetails } from "../extension/commands/answer.ts";
import { runCommand } from "../extension/commands/run.ts";
import type { MessageDeps, SendMessage } from "../extension/deps.ts";
import type { CommandCtx } from "../extension/pi.ts";
import { readJournal } from "../src/flow/index.ts";
import { fakeCtx } from "./fixtures/command-ctx.ts";
import { baseDeps } from "./fixtures/command-deps.ts";
import { catalogueOf, flowSpawn, flowText, type FlowTurn } from "./fixtures/flow.ts";
import { plainDirectory, repository } from "./fixtures/repo.ts";

initTheme();

/** Two agents one after the other: the second reads what the first found. */
const TWO = flowText("  - id: look\n    agent: scout\n    reads: [input]\n  - id: answer\n    agent: synthesiser\n    reads: [input, look]", { look: "Look.", answer: "Answer." }, "input: string", "two");
/** A flow that commits, which needs a repository. */
const COMMITS = flowText("  - id: message\n    agent: scout\n    reads: [input]\n  - id: save\n    commit: message", { message: "Write the message." }, "input: string", "commits");
/** A question with no default, which needs somebody there. */
const ASKS = flowText('  - id: sure\n    ask: "Go on?"\n    confirm: true', {}, "input: string", "asks");

type Sent = Parameters<SendMessage>[0];

/** `/run <args>` in `cwd`, its subagents playing `turns`: what it returned, told and sent, and the widget it drew. */
async function run(args: string, cwd: string, turns: FlowTurn[][] = [], over: { mode?: CommandCtx["mode"]; model?: string[] } = {}) {
	const { ctx, notes, widgets, said } = fakeCtx();
	ctx.cwd = cwd;
	ctx.mode = over.mode ?? "tui";
	const sent: Sent[] = [];
	const { spawn, requested } = flowSpawn(turns);
	let n = fs.existsSync(path.join(cwd, "runs")) ? fs.readdirSync(path.join(cwd, "runs")).length : 0;
	const deps: MessageDeps = {
		...baseDeps([]),
		loadFlowCatalogue: () => ({ ...catalogueOf({ two: TWO, commits: COMMITS, asks: ASKS }), cwd }),
		removedPipelines: () => [],
		checkModel: async (pattern) => void over.model?.push(pattern),
		runDir: () => {
			const dir = path.join(cwd, "runs", `run-${++n}`);
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		},
		spawn,
		sendMessage: (message) => void sent.push(message),
	};
	const result = await runCommand(args, ctx, deps);
	return { result, notes, said, sent, widgets, requested };
}

const answered = (text: string): FlowTurn[] => [{ text }];

describe("/run", () => {
	test("alone, it lists the flows there are", async () => {
		const { said, sent } = await run("", plainDirectory());
		assert.match(said(), /^3 flows/);
		assert.match(said(), /two\s+project/);
		assert.equal(sent.length, 0);
	});

	test("runs the flow in a run directory, and leaves its answer, how it ended and its last frame in the conversation", async () => {
		const cwd = plainDirectory();
		const model: string[] = [];
		const { result, sent, widgets, requested } = await run("--model local/one --timeout 10m two where is the journal written?", cwd, [answered("src/flow/run/journal.ts"), answered("In journal.ts.")], { model });

		assert.ok(result?.ok, JSON.stringify(result));
		assert.deepEqual(model, ["local/one"], "--model is checked before anything runs");
		assert.deepEqual(requested.map((one) => one.options.model), ["local/one", "local/one"]);
		const runDir = path.join(cwd, "runs", "run-1");
		for (const file of ["snapshot.json", "journal.jsonl", "usage.json"]) assert.ok(fs.existsSync(path.join(runDir, file)), `${file} is in the run directory`);

		assert.equal(sent.length, 1);
		const [message] = sent as [Sent];
		assert.equal(message.customType, RESULT_MESSAGE);
		assert.equal(message.content, "Result of the `two` flow, asked to: where is the journal written?\n\nIn journal.ts.\n\nok · runs/run-1");
		const details = message.details as ResultDetails;
		assert.equal(details.runDir, runDir);
		assert.equal(details.live?.summary.state, "done");
		assert.equal(details.live?.summary.visits, 2);

		const drawn = widgets.filter((lines) => lines !== undefined).map((lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""));
		assert.ok(drawn.some((frame) => /● look/.test(frame) && /○ answer/.test(frame)), `the widget draws the plan as it fills:\n${drawn.join("\n--\n")}`);
		assert.equal(widgets.at(-1), undefined, "the widget goes when the run does");
	});

	test("the flags may end the line, and an input written in quotes is the text inside", async () => {
		const model: string[] = [];
		const { sent, requested } = await run('two "where is it?" --model local/one', plainDirectory(), [answered("a"), answered("b")], { model });
		assert.deepEqual(model, ["local/one"]);
		assert.deepEqual(requested.map((one) => one.options.model), ["local/one", "local/one"]);
		assert.match((sent[0] as Sent).content, /^Result of the `two` flow, asked to: where is it\?\n/);
	});

	test("a failed run says where it failed and what a resume would do; /run resume carries it on from there", async () => {
		const cwd = plainDirectory();
		const failed = await run("two q", cwd, [answered("found"), [{ stopReason: "error", text: "" }]]);
		assert.equal(failed.result?.ok, false);
		assert.match((failed.sent[0] as Sent).content, /failed at answer: provider: .* · runs\/run-1 · \/run resume runs\/run-1 picks it up at answer$/);

		const resumed = await run("resume", cwd, [answered("From the journal.")]);
		assert.match(resumed.said(), /run: resuming two in runs\/run-1, from answer/);
		assert.ok(resumed.result?.ok, JSON.stringify(resumed.result));
		assert.match((resumed.sent[0] as Sent).content, /From the journal\.\n\nok · runs\/run-1$/);
		assert.equal(((resumed.sent[0] as Sent).details as ResultDetails).live?.summary.resumedFrom, "answer");
		assert.equal(readJournal(path.join(cwd, "runs", "run-1")).filter((entry) => entry.type === "life_start").length, 2);
	});

	test("/run resume names a run by its path, and refuses a run that ended well with why", async () => {
		const cwd = plainDirectory();
		await run("two q", cwd, [answered("a"), answered("b")]);

		const latest = await run("resume", cwd);
		assert.match(latest.said(), /nothing here to resume - the last run, runs\/run-1, cannot be: the run already ended well/);
		const named = await run("resume runs/run-1", cwd);
		assert.match(named.said(), /runs\/run-1 cannot be resumed - the run already ended well/);
		assert.equal(named.sent.length, 0);
	});

	test("/run resume with nothing to resume, or given a model, says so and runs nothing", async () => {
		const cwd = plainDirectory();
		assert.match((await run("resume", cwd)).said(), /no run here to resume/);
		assert.match((await run("--model local/one resume", cwd)).said(), /a resume runs on the model its run started with/);
		assert.match((await run("resume runs/none", cwd)).said(), /snapshot\.json/);
	});

	test("what is refused before anything runs is said, and spawns nothing", async () => {
		const cwd = plainDirectory();
		const cases: [string, RegExp][] = [
			["two", /say what two should work on/],
			["--timeout soon two q", /--timeout takes a duration/],
			["ghost q", /^run: `ghost` is unknown; the flows are two, commits, asks$/],
			["commits q", /`commits` cannot run here\n.*save\.commit: .* is not in a git repository/],
		];
		for (const [args, told] of cases) {
			const { said, requested, sent } = await run(args, cwd);
			assert.match(said(), told, args);
			assert.equal(requested.length, 0, `${args}: nothing spawned`);
			assert.equal(sent.length, 0);
		}
		assert.ok(!fs.existsSync(path.join(cwd, "runs")), "no run directory for a run that never started");
	});

	test("with nobody there, a question nobody can leave unanswered refuses the run", async () => {
		// RPC mode has dialogs but no card: `custom()` returns nothing there.
		for (const mode of ["print", "rpc"] as const) {
			const { said } = await run("asks q", repository(), [], { mode });
			assert.match(said(), /sure\.ask: this run is launched with nobody there/, mode);
		}
	});

	test("in a repository, a flow that commits runs, and its commit lands on the run's branch", async () => {
		const cwd = repository({ "a.txt": "a\n" });
		const { result, sent } = await run("commits add a", cwd, [answered("add a")]);
		assert.ok(result?.ok, JSON.stringify(result));
		assert.match((sent[0] as Sent).content, /ok · runs\/run-1$/);
	});
});
