/**
 * Exporting a run, on a real temporary directory.
 *
 * The filesystem here is genuine - an export whose only proof is a mocked
 * `writeFileSync` proves nothing about the file a human is meant to open. What
 * stays fake is pi: the sessions are `fakeSession`s whose export methods behave
 * like pi's, including the one refusal that matters (an in-memory session has
 * no HTML).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	copyMainSession,
	createRunDir,
	exportBaseName,
	exportSession,
	usageReport,
	writeUsageReport,
} from "../src/export.ts";
import { createTuiCollector } from "../src/reporters/tui.ts";
import type { SessionPort } from "../src/session.ts";
import { spawn } from "../src/subagent.ts";
import { emptyUsage } from "../src/usage.ts";
import { fakeSession } from "./fixtures/fake-session.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

const scratch: string[] = [];

/** A temporary directory, removed after the test. */
function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-export-"));
	scratch.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A session that exports like pi's does: both formats, real files. */
function exportableSession(): SessionPort {
	const session = fakeSession([{ text: "done" }]);
	return Object.assign(session, {
		exportToJsonl(outputPath?: string) {
			const file = outputPath ?? "session.jsonl";
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, '{"type":"session"}\n');
			return file;
		},
		async exportToHtml(outputPath?: string) {
			const file = outputPath ?? "session.html";
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "<html></html>");
			return file;
		},
	});
}

/** What pi actually does with a session that was never written to disk. */
function inMemorySession(): SessionPort {
	const session = fakeSession([{ text: "done" }]);
	return Object.assign(session, {
		exportToJsonl(outputPath?: string) {
			const file = outputPath ?? "session.jsonl";
			fs.writeFileSync(file, '{"type":"session"}\n');
			return file;
		},
		async exportToHtml(): Promise<string> {
			throw new Error("Cannot export in-memory session to HTML");
		},
	});
}

describe("createRunDir", () => {
	test("creates a sortable, filesystem-safe directory", () => {
		const base = tmpDir();
		const dir = createRunDir(base, new Date("2026-07-19T16:52:32.305Z"));

		assert.equal(path.basename(dir), "2026-07-19_16-52-32");
		assert.ok(fs.statSync(dir).isDirectory());
		assert.equal(fs.realpathSync(path.dirname(dir)), fs.realpathSync(base));
	});

	test("two runs never collide", () => {
		const base = tmpDir();
		const first = createRunDir(base, new Date("2026-07-19T16:52:32Z"));
		const second = createRunDir(base, new Date("2026-07-19T16:52:33Z"));
		assert.notEqual(first, second);
	});
});

describe("exportBaseName", () => {
	test("turns an id into something a browser can open", () => {
		assert.equal(exportBaseName("reviewer#2"), "reviewer-2");
		assert.equal(exportBaseName("scout#1"), "scout-1");
	});
});

describe("exportSession", () => {
	test("writes both formats, named after the subagent", async () => {
		const dir = tmpDir();
		const result = await exportSession(exportableSession(), dir, "reviewer#2");

		assert.equal(result.error, undefined);
		assert.equal(result.jsonl, path.join(dir, "reviewer-2.jsonl"));
		assert.equal(result.html, path.join(dir, "reviewer-2.html"));
		assert.deepEqual(fs.readdirSync(dir).sort(), ["reviewer-2.html", "reviewer-2.jsonl"]);
	});

	test("an in-memory session still yields its JSONL, and says why the HTML is missing", async () => {
		const dir = tmpDir();
		const result = await exportSession(inMemorySession(), dir, "scout#1");

		assert.ok(result.jsonl, "the transcript is worth having even without the HTML");
		assert.equal(result.html, undefined);
		assert.match(result.error ?? "", /in-memory/);
	});

	test("a session with no export methods at all is reported, not thrown", async () => {
		const dir = tmpDir();
		const result = await exportSession(fakeSession(), dir, "scout#1");

		assert.equal(result.html, undefined);
		assert.equal(result.jsonl, undefined);
		assert.equal(result.error, undefined, "nothing failed - there was simply nothing to call");
	});

	test("creates the directory it is given", async () => {
		const dir = path.join(tmpDir(), "nested", "deeper");
		const result = await exportSession(exportableSession(), dir, "scout#1");
		assert.ok(fs.existsSync(result.jsonl ?? ""));
	});
});

describe("usage.json", () => {
	/** Two subagents, one of them failed, driven through the collector. */
	function snapshot() {
		const collector = createTuiCollector();
		const feed = collector.reporter;

		feed({ type: "spawn", id: "scout#1", agent: "scout", lifetime: "task", openInHerdr: false, model: "local/qwen" });
		feed({ type: "status", id: "scout#1", status: "working", task: "find it" });
		feed({ type: "tool", id: "scout#1", name: "grep", args: { pattern: "x" } });
		feed({ type: "usage", id: "scout#1", usage: { ...emptyUsage(), turns: 1, busyMs: 600, input: 1_000, output: 100, cost: 0.01 } });
		feed({
			type: "close",
			id: "scout#1",
			result: {
				agent: "scout",
				output: "found",
				messages: [],
				usage: { ...emptyUsage(), turns: 1, busyMs: 600, input: 1_000, output: 100, cost: 0.01 },
				ok: true,
			},
		});

		feed({ type: "spawn", id: "coder#1", agent: "coder", lifetime: "workflow", openInHerdr: false });
		feed({ type: "status", id: "coder#1", status: "working", task: "write it" });
		feed({
			type: "close",
			id: "coder#1",
			result: {
				agent: "coder",
				output: "",
				messages: [],
				usage: { ...emptyUsage(), turns: 1, busyMs: 400, input: 500, output: 0, cost: 0.005 },
				ok: false,
				error: "provider exploded",
			},
		});

		return collector.snapshot();
	}

	test("aggregates rather than averages, and keeps a failure's tokens", () => {
		const report = usageReport(snapshot(), 700);

		assert.equal(report.total.subagents, 2);
		assert.equal(report.total.failed, 1);
		assert.equal(report.total.input, 1_500, "the failed branch spent its tokens too");
		assert.equal(report.total.busyMs, 1_000);
		assert.equal(report.wallMs, 700, "wall time is the run's, never the sum of the branches");
	});

	test("reports the parallelism achieved, which is the point of the two clocks", () => {
		const report = usageReport(snapshot(), 500);
		assert.equal(report.parallelism, 2, "1000ms of work in 500ms of wall time");
	});

	test("an empty run is zero, not NaN", () => {
		const report = usageReport(createTuiCollector().snapshot(), 0);
		assert.equal(report.parallelism, 0);
		assert.equal(report.total.subagents, 0);
	});

	test("each subagent keeps its identity, its model and its error", () => {
		const report = usageReport(snapshot(), 700);
		const [scout, coder] = report.subagents;

		assert.equal(scout?.model, "local/qwen");
		assert.equal(scout?.task, "find it");
		assert.equal(scout?.toolCalls, 1);
		assert.equal(coder?.lifetime, "workflow");
		assert.equal(coder?.ok, false);
		assert.equal(coder?.error, "provider exploded");
	});

	test("writes readable JSON that round-trips", () => {
		const dir = tmpDir();
		const file = writeUsageReport(dir, usageReport(snapshot(), 700));

		assert.equal(file, path.join(dir, "usage.json"));
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		assert.equal(parsed.subagents.length, 2);
		assert.equal(parsed.total.cost, 0.015);
	});
});

describe("copyMainSession", () => {
	test("puts the parent session next to the subagents' transcripts", () => {
		const dir = tmpDir();
		const source = path.join(dir, "source.jsonl");
		fs.writeFileSync(source, '{"type":"session"}\n');

		const result = copyMainSession(source, dir);
		assert.equal(result.jsonl, path.join(dir, "main.jsonl"));
		assert.equal(fs.readFileSync(path.join(dir, "main.jsonl"), "utf-8"), '{"type":"session"}\n');
	});

	test("an in-memory parent is reported, never thrown", () => {
		const result = copyMainSession(undefined, tmpDir());
		assert.equal(result.jsonl, undefined);
		assert.match(result.error ?? "", /in memory/);
	});

	test("a missing file is reported, never thrown", () => {
		const dir = tmpDir();
		const result = copyMainSession(path.join(dir, "gone.jsonl"), dir);
		assert.ok(result.error, "the run must survive a failed export");
	});
});

describe("a subagent's own export", () => {
	const agent = testAgent("scout");

	test("exportDir implies a session directory: pi cannot render an in-memory session", async () => {
		const dir = tmpDir();
		const seen: { sessionDir?: string }[] = [];
		const subagent = await spawn(agent, {
			exportDir: dir,
			createSession: async (_agent, options) => {
				seen.push(options);
				return exportableSession();
			},
		});
		await subagent.close();

		assert.equal(seen[0]?.sessionDir, path.join(dir, ".sessions"));
	});

	test("closing exports, while the session is still alive", async () => {
		const dir = tmpDir();
		const subagent = await spawn(agent, { exportDir: dir, createSession: async () => exportableSession() });
		await subagent.ask("find it");
		await subagent.close();

		// Ids are per-process, so the file names follow this subagent's own id.
		const name = exportBaseName(subagent.id);
		assert.deepEqual(fs.readdirSync(dir).sort(), [`${name}.html`, `${name}.jsonl`]);
	});

	test("exports on demand, mid-flight: an interrupted run must keep what it did", async () => {
		const dir = tmpDir();
		const subagent = await spawn(agent, { createSession: async () => exportableSession() });
		await subagent.ask("find it");

		const result = await subagent.export(dir);
		assert.ok(result.jsonl && fs.existsSync(result.jsonl));
		await subagent.close();
	});

	test("without an export directory, nothing is written anywhere", async () => {
		const dir = tmpDir();
		const subagent = await spawn(agent, { createSession: async () => exportableSession() });
		const result = await subagent.export();

		await subagent.close();
		assert.match(result.error ?? "", /no export directory/);
		assert.deepEqual(fs.readdirSync(dir), []);
	});

	test("exporting a closed subagent is reported, not thrown: its session is gone", async () => {
		const dir = tmpDir();
		const subagent = await spawn(agent, { createSession: async () => exportableSession() });
		await subagent.close();

		const result = await subagent.export(dir);
		assert.match(result.error ?? "", /closed/);
	});
});
