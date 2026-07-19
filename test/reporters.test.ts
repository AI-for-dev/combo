import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { autoReporter, consoleReporter, silentReporter } from "../src/reporters/index.ts";
import { createHerdrReporterWith } from "../src/reporters/herdr.ts";
import { detectHerdr, type HerdrSend } from "../src/reporters/herdr-client.ts";
import type { SubagentEvent } from "../src/events.ts";
import { emptyUsage } from "../src/usage.ts";

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	tmpDirs.push(dir);
	return dir;
}

const spawnEvent = (id: string, openInHerdr: boolean): SubagentEvent => ({
	type: "spawn",
	id,
	agent: id.split("#")[0] as string,
	lifetime: "task",
	openInHerdr,
});

const closeEvent = (id: string): SubagentEvent => ({
	type: "close",
	id,
	result: { agent: id, output: "", messages: [], usage: emptyUsage(), ok: true },
});

/**
 * A `HerdrSend` that records calls and answers like the real server.
 *
 * `paneId` is not a defaulted parameter on purpose: passing `undefined` to a
 * default would silently restore the default, which is exactly the case the
 * "no pane id" test needs to exercise.
 */
function recorder(paneId: string | null = "w1:p9") {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const send: HerdrSend = async (method, params) => {
		calls.push({ method, params });
		if (method !== "agent.start") return { result: {} };
		return paneId === null ? { result: { agent: {} } } : { result: { agent: { pane_id: paneId } } };
	};
	return { send, calls, methods: () => calls.map((call) => call.method) };
}

/** Lets the reporter's fire-and-forget promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("detectHerdr", () => {
	test("needs all three markers", () => {
		const full = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s.sock", HERDR_PANE_ID: "w1:p1" };
		assert.deepEqual(detectHerdr(full), { socketPath: "/tmp/s.sock", paneId: "w1:p1" });

		assert.equal(detectHerdr({ ...full, HERDR_SOCKET_PATH: undefined }), undefined);
		assert.equal(detectHerdr({ ...full, HERDR_PANE_ID: undefined }), undefined);
		assert.equal(detectHerdr({ ...full, HERDR_ENV: undefined }), undefined);
	});

	test('HERDR_ENV must be exactly "1"', () => {
		const base = { HERDR_SOCKET_PATH: "/tmp/s.sock", HERDR_PANE_ID: "w1:p1" };
		assert.equal(detectHerdr({ ...base, HERDR_ENV: "0" }), undefined);
		assert.equal(detectHerdr({ ...base, HERDR_ENV: "true" }), undefined);
	});

	test("an empty environment is not an error, just an absence", () => {
		assert.equal(detectHerdr({}), undefined);
	});
});

describe("herdr reporter", () => {
	test("opens a split per subagent that asked for one", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		await settle();

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.method, "agent.start");
		assert.equal(calls[0]?.params.name, "scout#1");
		assert.equal(calls[0]?.params.split, "right");
		assert.equal(calls[0]?.params.focus, false);
		const argv = calls[0]?.params.argv as string[];
		assert.equal(argv[0], "tail", "the pane displays a stream we write, it does not host the subagent");
	});

	test("a subagent without openInHerdr produces no request at all", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		report(spawnEvent("scout#1", false));
		report({ type: "tool", id: "scout#1", name: "grep", args: {} });
		report({ type: "status", id: "scout#1", status: "working" });
		report(closeEvent("scout#1"));
		await settle();

		assert.deepEqual(calls, [], "opt-in means opt-in");
	});

	test("the full life of a split: start, report, release, close", async () => {
		const { send, methods } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		await settle();
		report({ type: "status", id: "scout#1", status: "working" });
		await settle();
		report({ type: "status", id: "scout#1", status: "done" });
		await settle();
		report(closeEvent("scout#1"));
		await settle();

		assert.deepEqual(methods(), [
			"agent.start",
			"pane.report_agent",
			"pane.report_agent",
			"pane.release_agent",
			"pane.close",
		]);
	});

	test('"done" is reported as idle: herdr\'s PaneAgentState has no done', async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		await settle();
		report({ type: "status", id: "scout#1", status: "done" });
		await settle();

		const reported = calls.find((call) => call.method === "pane.report_agent");
		assert.equal(reported?.params.state, "idle");
	});

	test("blocked and working pass through unchanged", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		await settle();
		report({ type: "status", id: "scout#1", status: "working" });
		report({ type: "status", id: "scout#1", status: "blocked" });
		await settle();

		assert.deepEqual(
			calls.filter((call) => call.method === "pane.report_agent").map((call) => call.params.state),
			["working", "blocked"],
		);
	});

	test("seq increases monotonically, so herdr can order our reports", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		await settle();
		report({ type: "status", id: "scout#1", status: "working" });
		report({ type: "status", id: "scout#1", status: "idle" });
		await settle();

		const seqs = calls.map((call) => call.params.seq).filter((seq): seq is number => typeof seq === "number");
		assert.ok(seqs.length >= 2);
		for (let i = 1; i < seqs.length; i++) {
			assert.ok((seqs[i] as number) > (seqs[i - 1] as number), `seq must increase: ${seqs.join(", ")}`);
		}
	});

	test("tool calls and text land in the file the pane tails", async () => {
		const dir = tmpDir();
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir });

		report(spawnEvent("scout#1", true));
		report({ type: "tool", id: "scout#1", name: "grep", args: { pattern: "spawn" } });
		report({ type: "text", id: "scout#1", delta: "found it" });
		await settle();

		const logPath = (calls[0]?.params.argv as string[]).at(-1) as string;
		const content = fs.readFileSync(logPath, "utf8");
		assert.match(content, /scout#1/);
		assert.match(content, /\$ grep pattern=spawn/);
		assert.match(content, /found it/);
	});

	test("the final usage line is written before the pane closes", async () => {
		const dir = tmpDir();
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir });

		report(spawnEvent("scout#1", true));
		await settle();
		const logPath = (calls[0]?.params.argv as string[]).at(-1) as string;

		report({
			type: "close",
			id: "scout#1",
			result: { agent: "scout", output: "", messages: [], ok: true, usage: { ...emptyUsage(), turns: 2, busyMs: 1_500 } },
		});
		// Read before the async close removes the file.
		const content = fs.readFileSync(logPath, "utf8");
		assert.match(content, /2 turns 1\.5s/);
		await settle();
	});

	test("a transport that fails never propagates: the display is not a participant", async () => {
		const failing: HerdrSend = async () => {
			throw new Error("herdr went away");
		};
		const report = createHerdrReporterWith(failing, { dir: tmpDir() });

		assert.doesNotThrow(() => {
			report(spawnEvent("scout#1", true));
			report({ type: "status", id: "scout#1", status: "working" });
			report(closeEvent("scout#1"));
		});
		await settle();
	});

	test("a herdr that never returns a pane id degrades to writing only", async () => {
		const { send, methods } = recorder(null);
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		await settle();
		report({ type: "status", id: "scout#1", status: "working" });
		await settle();

		assert.deepEqual(methods(), ["agent.start"], "no pane id, nothing to report on");
	});

	test("several subagents get independent splits", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		report(spawnEvent("scout#2", true));
		await settle();

		assert.deepEqual(
			calls.filter((call) => call.method === "agent.start").map((call) => call.params.name),
			["scout#1", "scout#2"],
		);
	});

	test("events for an unknown id are ignored, not crashed on", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		assert.doesNotThrow(() => report({ type: "tool", id: "never-spawned#1", name: "grep", args: {} }));
		await settle();
		assert.deepEqual(calls, []);
	});
});

describe("autoReporter", () => {
	test("falls back silently when herdr is absent", () => {
		// The test process has no HERDR_* variables, which is exactly the case.
		const report = autoReporter();
		assert.doesNotThrow(() => report(spawnEvent("scout#1", true)));
	});

	test("uses the fallback it was given", () => {
		const seen: string[] = [];
		const report = autoReporter({ fallback: (event) => seen.push(event.type) });

		report(spawnEvent("scout#1", true));
		assert.deepEqual(seen, ["spawn"]);
	});
});

describe("silentReporter", () => {
	test("emits nothing and never throws", () => {
		assert.doesNotThrow(() => silentReporter(spawnEvent("scout#1", true)));
	});
});

describe("consoleReporter", () => {
	test("writes one line per event that matters", () => {
		const lines: string[] = [];
		const report = consoleReporter({ write: (line) => lines.push(line) });

		report(spawnEvent("scout#1", false));
		report({ type: "tool", id: "scout#1", name: "grep", args: {} });
		report({ type: "status", id: "scout#1", status: "working" });
		report(closeEvent("scout#1"));

		assert.equal(lines.length, 3, "status is state, not news");
		assert.match(lines[0] as string, /scout#1/);
		assert.match(lines[1] as string, /→ grep/);
		assert.match(lines[2] as string, /^✓ scout#1/);
	});

	test("streamed text is off by default, because it is noisy", () => {
		const quiet: string[] = [];
		consoleReporter({ write: (line) => quiet.push(line) })({ type: "text", id: "scout#1", delta: "hello" });
		assert.deepEqual(quiet, []);

		const loud: string[] = [];
		consoleReporter({ write: (line) => loud.push(line), text: true })({ type: "text", id: "scout#1", delta: "hello" });
		assert.deepEqual(loud, ["hello"]);
	});
});
