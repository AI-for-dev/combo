import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { checked, watched } from "../extension/command.ts";
import { resolved } from "../extension/deps.ts";
import { loadAgents, runPipeline } from "../src/index.ts";
import { fakeCtx } from "./fixtures/command-ctx.ts";
import { fakeSpawn, testAgent } from "./fixtures/fake-subagent.ts";

const runs = mkdtempSync(join(tmpdir(), "combo-command-"));
after(() => rmSync(runs, { recursive: true, force: true }));

describe("resolved", () => {
	test("fills what was left unsaid with the real thing, and keeps what was said", () => {
		const mine = () => "/somewhere";
		const deps = resolved({ runDir: mine });

		assert.equal(deps.runDir, mine);
		assert.equal(deps.loadAgents, loadAgents);
		assert.equal(deps.runPipeline, runPipeline);
	});

	test("a key holding undefined counts as unsaid", () => {
		// A caller that builds its deps by merging hands over `{ runDir: undefined }`
		// for an option nobody set; spread over a default, that would win.
		const deps = resolved({ runDir: undefined, loadAgents: undefined });

		assert.equal(typeof deps.runDir(), "string");
		assert.equal(deps.loadAgents, loadAgents);
	});

	test("verify, spawn and tickMs stay optional: for them, absent is an answer", () => {
		const deps = resolved({});
		assert.equal(deps.verify, undefined);
		assert.equal(deps.spawn, undefined);
		assert.equal(deps.tickMs, undefined);
	});
});

describe("checked", () => {
	test("hands back what the checks produced", async () => {
		const { ctx, notes } = fakeCtx();
		assert.equal(await checked(ctx, () => 42), 42);
		assert.equal(await checked(ctx, async () => "later"), "later");
		assert.deepEqual(notes, []);
	});

	test("a thrown explanation is shown as an error, and nothing comes back", async () => {
		const { ctx, notes } = fakeCtx();
		const outcome = await checked(ctx, () => {
			throw new Error("build: `nobody` is not an agent");
		});

		assert.equal(outcome, undefined);
		assert.deepEqual(notes, [{ message: "build: `nobody` is not an agent", type: "error" }]);
	});

	test("something thrown that is not an Error is still shown", async () => {
		const { ctx, notes } = fakeCtx();
		await checked(ctx, () => {
			throw "a bare string";
		});
		assert.equal(notes[0]?.message, "a bare string");
	});
});

describe("watched", () => {
	test("says what is running while it runs, and clears the footer and the widget after", async () => {
		const { ctx, statuses, widgets } = fakeCtx();
		let statusWhileWorking: string | undefined;

		const done = await watched(ctx, { tickMs: 0 }, {
			status: "running explore…",
			dir: undefined,
			work: async () => {
				statusWhileWorking = statuses.at(-1);
				return "the answer";
			},
		});

		assert.equal(done, "the answer");
		assert.equal(statusWhileWorking, "running explore…");
		assert.equal(statuses.at(-1), undefined, "no stale footer for the rest of the session");
		assert.equal(widgets.at(-1), undefined, "no dead row of dots above the prompt");
	});

	test("a thrown work still throws, after the clean-up", async () => {
		const { ctx, statuses, widgets } = fakeCtx();

		await assert.rejects(
			watched(ctx, { tickMs: 0 }, {
				status: "building…",
				dir: undefined,
				work: async () => {
					throw new Error("the pipeline exploded");
				},
			}),
			/exploded/,
		);

		assert.equal(statuses.at(-1), undefined);
		assert.equal(widgets.at(-1), undefined);
	});

	test("hands the work a live run: the signal, the spawn and the listener to give the workflow", async () => {
		const { ctx } = fakeCtx();
		await watched(ctx, { tickMs: 0 }, {
			status: "x",
			dir: undefined,
			work: async (live) => {
				assert.ok(live.signal instanceof AbortSignal);
				assert.equal(typeof live.spawn, "function");
				assert.equal(typeof live.onEvent, "function");
			},
		});
	});

	test("what a caller varies about the view is passed through: its spawn is the one the run wraps", async () => {
		const { ctx } = fakeCtx();
		const fake = fakeSpawn();

		await watched(ctx, { tickMs: 0 }, {
			dir: undefined,
			live: { spawn: fake.spawn },
			work: async (live) => {
				const subagent = await live.spawn(testAgent("scout"), {});
				await subagent.close();
			},
		});

		assert.deepEqual(fake.spawned.map((one) => one.agent), ["scout"]);
	});

	test("with no status, the footer is left alone", async () => {
		const { ctx, statuses } = fakeCtx();
		await watched(ctx, { tickMs: 0 }, { dir: undefined, work: async () => undefined });
		assert.deepEqual(statuses.filter((one) => one !== undefined), []);
	});

	test("writes usage.json into the folder it was given, with the time it measured", async () => {
		const { ctx } = fakeCtx();
		const dir = join(runs, "a-run");

		await watched(ctx, { tickMs: 0 }, { status: "x", dir, work: async () => undefined });

		const report = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8")) as { wallMs: number };
		assert.ok(report.wallMs >= 0);
	});

	test("a run with no folder writes nothing", async () => {
		const { ctx } = fakeCtx();
		await watched(ctx, { tickMs: 0 }, { status: "x", dir: undefined, work: async () => undefined });
		assert.ok(!existsSync(join(runs, "usage.json")));
	});
});
