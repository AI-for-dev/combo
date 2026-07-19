/**
 * The extension's tool body, offline.
 *
 * This is the path that had no coverage and where three user-visible bugs hid
 * behind a green suite: the wiring between the tool arguments, the reporters
 * and the combinators. Everything it touches is injected here - the agents, the
 * spawn, the second reporter, the widget surface - so no network, no disk and
 * no terminal are involved.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { executeSubagent, inferMode, paintWidget, textForModel, WIDGET } from "../extension/execute.ts";
import type { SubagentEvent } from "../src/events.ts";
import type { Details } from "../extension/execute.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const scout = testAgent("scout");
const coder = testAgent("coder");
const reviewer = testAgent("reviewer");
const agents = [scout, coder, reviewer];

/** The text the model actually receives. */
const say = (output: { content: { text: string }[] }) => output.content[0]?.text ?? "";

/** Records what the tool asked the UI to display. */
function fakeUi() {
	const widgets: (string[] | undefined)[] = [];
	return {
		widgets,
		ui: {
			theme: { fg: (_colour: string, text: string) => text },
			setWidget(key: string, lines: string[] | undefined) {
				assert.equal(key, WIDGET);
				widgets.push(lines);
			},
		},
	};
}

/** The deps every test shares: no disk, no network, no timer. */
function deps(over: Record<string, unknown> = {}) {
	return { loadAgents: () => agents, tickMs: 0, ...over };
}

describe("inferMode", () => {
	test("reads the mode from the arguments that were actually given", () => {
		assert.equal(inferMode({}), "single");
		assert.equal(inferMode({ agent: "scout", task: "x" }), "single");
		assert.equal(inferMode({ agent: "scout", tasks: ["a", "b"] }), "parallel");
		assert.equal(inferMode({ steps: ["coder", "reviewer"] }), "chain");
		assert.equal(inferMode({ steps: ["coder"], until: "LGTM" }), "loop");
		assert.equal(inferMode({ steps: ["coder"], maxIterations: 2 }), "loop");
		assert.equal(inferMode({ agent: "scout", tasks: ["a", "b"], reduceWith: "reviewer" }), "reduce");
	});

	test("an explicit mode always wins over the inference", () => {
		assert.equal(inferMode({ mode: "chain", tasks: ["a"] }), "chain");
	});
});

describe("executeSubagent", () => {
	test("single: one spawn, the output handed back to the model", async () => {
		const fake = fakeSpawn();
		const output = await executeSubagent({ agent: "scout", task: "find the auth code" }, deps({ spawn: fake.spawn }));

		assert.equal(fake.spawned.length, 1);
		assert.deepEqual(fake.asks, [{ id: "scout#1", task: "find the auth code" }]);
		assert.match(say(output), /## scout/);
		assert.match(say(output), /scout\(find the auth code\)/);
		assert.equal((output.details as Details).mode, "single");
	});

	test("parallel: one subagent per task, all of them reported", async () => {
		const fake = fakeSpawn();
		const output = await executeSubagent({ agent: "scout", tasks: ["a", "b", "c"] }, deps({ spawn: fake.spawn }));

		assert.equal(fake.spawned.length, 3);
		assert.equal(output.details.subagents.length, 3);
		assert.equal(output.details.mode, "parallel");
	});

	test("chain: the steps run in order and each one is a step of the chain", async () => {
		const fake = fakeSpawn();
		const output = await executeSubagent({ steps: ["coder", "reviewer"], task: "parse it" }, deps({ spawn: fake.spawn }));

		assert.deepEqual(
			fake.spawned.map((one) => one.agent),
			["coder", "reviewer"],
		);
		assert.equal(fake.asks[0]?.task, "parse it");
		assert.match(fake.asks[1]?.task ?? "", /coder\(parse it\)/, "the reviewer sees the coder's output");
		assert.equal(output.details.mode, "chain");
	});

	test("loop: `until` becomes a predicate on the last output, and convergence is reported", async () => {
		const fake = fakeSpawn(() => ({ output: "all good: LGTM" }));
		const output = await executeSubagent(
			{ steps: ["coder", "reviewer"], task: "parse it", until: "LGTM", maxIterations: 3 },
			deps({ spawn: fake.spawn }),
		);

		assert.equal(output.details.converged, true);
		assert.equal(output.details.iterations, 1);
		assert.match(say(output), /converged after 1 iteration/);
	});

	test("a loop that never converges says so, rather than reading as a success", async () => {
		const fake = fakeSpawn(() => ({ output: "still wrong" }));
		const output = await executeSubagent(
			{ steps: ["coder"], task: "parse it", until: "LGTM", maxIterations: 2 },
			deps({ spawn: fake.spawn }),
		);

		assert.equal(output.details.converged, false);
		assert.match(say(output), /did NOT converge after 2/);
	});

	test("a failed subagent comes back as a labelled result, not as a throw", async () => {
		const fake = fakeSpawn(() => ({ ok: false, error: "provider exploded" }));
		const output = await executeSubagent({ agent: "scout", task: "x" }, deps({ spawn: fake.spawn }));

		assert.match(say(output), /## scout \(failed\)/);
		assert.match(say(output), /provider exploded/);
		assert.equal(output.details.subagents[0]?.ok, false);
	});

	test("lifetime travels to the spawn: `workflow` reuses one subagent per agent", async () => {
		const persistent = fakeSpawn(() => ({ output: "nope" }));
		await executeSubagent(
			{ steps: ["coder", "reviewer"], task: "x", maxIterations: 3, lifetime: "workflow" },
			deps({ spawn: persistent.spawn }),
		);

		const fresh = fakeSpawn(() => ({ output: "nope" }));
		await executeSubagent({ steps: ["coder", "reviewer"], task: "x", maxIterations: 3 }, deps({ spawn: fresh.spawn }));

		assert.equal(persistent.spawned.length, 2, "one coder and one reviewer, kept across iterations");
		assert.equal(fresh.spawned.length, 6, "a fresh pair at every iteration");
	});

	test("timeoutMs reaches every turn", async () => {
		const fake = fakeSpawn();
		await executeSubagent({ agent: "scout", task: "x", timeoutMs: 1234 }, deps({ spawn: fake.spawn }));
		assert.equal(fake.askOptions[0]?.timeoutMs, 1234);
	});

	test("openInHerdr reaches a subscribed reporter - the bug that had no clue", async () => {
		const events: SubagentEvent[] = [];
		const fake = fakeSpawn();
		await executeSubagent(
			{ agent: "scout", task: "x", openInHerdr: true },
			deps({ spawn: fake.spawn, reporter: (event: SubagentEvent) => void events.push(event) }),
		);

		const spawnEvent = events.find((event) => event.type === "spawn");
		assert.ok(spawnEvent, "the second reporter must actually be subscribed");
		assert.equal(fake.spawned[0]?.options.openInHerdr, true);
	});

	test("the scope is passed on, so project agents stay opt-in", async () => {
		const seen: unknown[] = [];
		const recordScope = (options: unknown) => (seen.push(options), agents);
		const fake = fakeSpawn();
		await executeSubagent(
			{ agent: "scout", task: "x", scope: "both" },
			deps({ spawn: fake.spawn, loadAgents: recordScope }),
		);
		assert.deepEqual(seen, [{ cwd: undefined, scope: "both" }]);

		await executeSubagent({ agent: "scout", task: "x", scope: "nonsense" }, deps({ spawn: fake.spawn, loadAgents: recordScope }));
		assert.deepEqual(seen[1], { cwd: undefined, scope: undefined }, "an unknown scope falls back to the default");
	});

	test("an unknown agent is a caller error, and still clears the widget", async () => {
		const { widgets, ui } = fakeUi();
		await assert.rejects(
			() => executeSubagent({ agent: "ghost", task: "x" }, deps({ spawn: fakeSpawn().spawn, ui })),
			/ghost/,
		);
		assert.equal(widgets.at(-1), undefined, "no dead row of dots above the prompt");
	});

	test("a missing agent name is refused before anything is spawned", async () => {
		const fake = fakeSpawn();
		await assert.rejects(() => executeSubagent({ task: "x" }, deps({ spawn: fake.spawn })), /`agent` is required/);
		assert.equal(fake.spawned.length, 0);
	});

	test("chain and loop refuse to run without steps", async () => {
		await assert.rejects(() => executeSubagent({ mode: "chain", task: "x" }, deps()), /`steps` is required/);
		await assert.rejects(() => executeSubagent({ mode: "loop", task: "x" }, deps()), /`steps` is required/);
	});

	test("the caller's signal reaches the workflow: nothing runs, nothing reads as a success", async () => {
		const fake = fakeSpawn();
		const output = await executeSubagent(
			{ agent: "scout", tasks: ["a", "b"] },
			deps({ spawn: fake.spawn, signal: AbortSignal.abort() }),
		);

		assert.equal(fake.asks.length, 0, "an aborted signal must stop the turns");
		assert.match(say(output), /## scout \(failed\)\naborted/);
	});

	test("the widget is painted while working and removed when the work ends", async () => {
		const { widgets, ui } = fakeUi();
		const fake = fakeSpawn();
		await executeSubagent({ agent: "scout", task: "x" }, deps({ spawn: fake.spawn, ui }));

		assert.ok(widgets.length > 1, "the widget is repainted as events arrive");
		assert.ok(
			widgets.some((lines) => lines?.some((line) => line.includes("scout#1"))),
			"the dots name the subagents",
		);
		assert.equal(widgets.at(-1), undefined, "the widget disappears as soon as the work ends");
	});

	test("progress is streamed, not held back until the end", async () => {
		const updates: string[] = [];
		const fake = fakeSpawn();
		await executeSubagent(
			{ agent: "scout", tasks: ["a", "b"] },
			deps({ spawn: fake.spawn, onUpdate: (update: { content: { text: string }[] }) => void updates.push(say(update)) }),
		);

		assert.ok(updates.length > 0, "onUpdate must be called while the subagents work");
		assert.match(updates.at(-1) ?? "", /2\/2 done/);
	});

	test("export: the run directory is created, the subagents export into it, usage.json lands", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-run-"));
		try {
			const fake = fakeSpawn();
			const output = await executeSubagent(
				{ agent: "scout", tasks: ["a", "b"], export: true },
				deps({ spawn: fake.spawn, runDir: () => dir }),
			);

			assert.deepEqual(
				fake.spawned.map((one) => one.options.exportDir),
				[dir, dir],
				"every subagent writes into the run directory",
			);
			assert.equal(output.details.exportDir, dir, "the row tells the user where it went");

			const report = JSON.parse(fs.readFileSync(path.join(dir, "usage.json"), "utf-8"));
			assert.equal(report.subagents.length, 2);
			assert.equal(report.total.subagents, 2);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("export: nothing is written when nobody asked", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-run-"));
		try {
			const fake = fakeSpawn();
			const output = await executeSubagent({ agent: "scout", task: "a" }, deps({ spawn: fake.spawn, runDir: () => dir }));

			assert.equal(output.details.exportDir, undefined);
			assert.equal(fake.spawned[0]?.options.exportDir, undefined);
			assert.deepEqual(fs.readdirSync(dir), [], "an export is opt-in, like everything else that leaves a trace");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("export: a run that throws still leaves its usage.json behind", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-run-"));
		try {
			await assert.rejects(() =>
				executeSubagent({ agent: "ghost", task: "x", export: true }, deps({ spawn: fakeSpawn().spawn, runDir: () => dir })),
			);
			assert.ok(fs.existsSync(path.join(dir, "usage.json")), "an interrupted run must export what it did");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("export: the parent session is copied in beside the subagents", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-run-"));
		const main = path.join(dir, "parent.jsonl");
		fs.writeFileSync(main, '{"type":"session"}\n');
		try {
			const fake = fakeSpawn();
			await executeSubagent(
				{ agent: "scout", task: "a", export: true },
				deps({ spawn: fake.spawn, runDir: () => dir, mainSessionFile: main }),
			);
			assert.ok(fs.existsSync(path.join(dir, "main.jsonl")));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reduce: the branches run, then one agent answers - and only that answer goes to the model", async () => {
		const fake = fakeSpawn((task, agent) => ({ output: agent.name === "reviewer" ? "one answer" : `branch(${task})` }));
		const output = await executeSubagent(
			{ agent: "scout", tasks: ["a", "b"], reduceWith: "reviewer", task: "what is going on?" },
			deps({ spawn: fake.spawn }),
		);

		assert.deepEqual(
			fake.spawned.map((one) => one.agent),
			["scout", "scout", "reviewer"],
		);
		assert.match(fake.asks[2]?.task ?? "", /what is going on\?/, "the question leads the reducer's prompt");
		assert.match(fake.asks[2]?.task ?? "", /branch\(a\)/, "the branches are the evidence");

		assert.equal(say(output), "## reviewer\none answer", "the branches must not be replayed into the caller's context");
		assert.equal(output.details.mode, "reduce");
		assert.equal(output.details.subagents.length, 3, "the row still shows every subagent that ran");
	});

	test("reduce: a missing reducer names the argument the caller forgot", async () => {
		const fake = fakeSpawn();
		await assert.rejects(
			() => executeSubagent({ mode: "reduce", agent: "scout", tasks: ["a"] }, deps({ spawn: fake.spawn })),
			/`reduceWith` is required/,
		);
	});

	test("no subagent at all is stated plainly", async () => {
		const fake = fakeSpawn();
		const output = await executeSubagent({ mode: "parallel", agent: "scout", tasks: [] }, deps({ spawn: fake.spawn }));
		assert.equal(say(output), "(no subagent ran)");
	});

	test("the task reaches the row, so the collapsed view is not a list of blanks", async () => {
		const fake = fakeSpawn();
		const output = await executeSubagent({ agent: "scout", task: "find the auth code" }, deps({ spawn: fake.spawn }));
		assert.equal(output.details.subagents[0]?.task, "find the auth code");
	});
});

describe("paintWidget", () => {
	test("colours nothing that widgetRows did not lay out", () => {
		const painted = paintWidget(
			{
				subagents: [
					{
						id: "scout#1",
						agent: "scout",
						lifetime: "task",
						status: "working",
						task: "x",
						tools: [],
						output: "",
						usage: { wallMs: 0, busyMs: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
					},
				],
				total: 1,
				done: 0,
				running: 1,
				failed: 0,
				usage: { wallMs: 0, busyMs: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			},
			{ fg: (colour, text) => `<${colour}>${text}` },
		);

		assert.ok(painted.some((line) => line.includes("scout#1")));
		assert.ok(painted.some((line) => line.includes("<accent>")), "a working subagent is the accent colour");
	});
});

describe("textForModel", () => {
	test("labels each agent's output and marks the failures", () => {
		const text = textForModel([
			{ agent: "scout", output: "found it", messages: [], usage: {} as never, ok: true },
			{ agent: "coder", output: "", messages: [], usage: {} as never, ok: false, error: "boom" },
		]);
		assert.match(text, /## scout\nfound it/);
		assert.match(text, /## coder \(failed\)\nboom/);
	});
});
