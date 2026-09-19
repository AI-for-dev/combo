import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import {
	autoReporter,
	combineReporters,
	consoleReporter,
	recordReporter,
	silentReporter,
} from "../src/reporters/index.ts";
import { BOARD_PANE, createHerdrReporterWith } from "../src/reporters/herdr.ts";
import { detectHerdr, type HerdrSend } from "../src/reporters/herdr-client.ts";
import type { SubagentEvent } from "../src/events.ts";
import { emptyUsage } from "../src/usage.ts";

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-test-"));
	tmpDirs.push(dir);
	return dir;
}

let launch = 0;

const spawnEvent = (id: string, openInHerdr: boolean, parentId?: string): SubagentEvent => ({
	type: "spawn",
	id,
	agent: id.split("#")[0] as string,
	order: ++launch,
	lifetime: "task",
	openInHerdr,
	parentId,
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

	test("the members talk on a pane of their own, and each keeps its half", async () => {
		const dir = tmpDir();
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir, all: true });

		report(spawnEvent("member#1", false));
		report(spawnEvent("member#2", false));
		report({ type: "read", id: "member#2", posts: [], waiting: 0 });
		report({
			type: "post",
			id: "member#1",
			post: { id: "p1", from: "member#1", to: "member#2", kind: "ask", text: "who has console.ts?", at: 4 },
		});
		report({ type: "claim", id: "member#2", key: "console.ts", action: "take", ok: false, heldBy: "member#1" });
		await settle();

		const paneFor = (name: string) =>
			calls.find((call) => call.method === "agent.start" && call.params.name === name)?.params.argv as string[] | undefined;

		const board = fs.readFileSync(paneFor(BOARD_PANE)?.at(-1) as string, "utf8");
		assert.match(board, /⇣ member#2 was handed nothing/, "the quiet half is the one a race needs");
		assert.match(board, /✉ member#1 → member#2 \[ask\] who has console.ts\?/);
		assert.match(board, /⚑ member#2 take console.ts → refused \(member#1\)/);

		const mine = fs.readFileSync(paneFor("member#2")?.at(-1) as string, "utf8");
		assert.match(mine, /⚑ take console.ts → refused \(member#1\)/, "its own name is in the header above");
		assert.ok(!mine.includes("member#1 → member#2"), "what it was not part of belongs on the board");
	});

	test("nobody watching means no board pane either", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir() });

		report(spawnEvent("member#1", false));
		report({ type: "post", id: "member#1", post: { id: "p1", from: "member#1", kind: "tell", text: "hello", at: 1 } });
		await settle();

		assert.deepEqual(calls, [], "a board pane over a run with no panes is a window nobody asked for");
	});

	test("the board closes with the last member, and releases no agent it never had", async () => {
		const { send, calls, methods } = recorder();
		const report = createHerdrReporterWith(send, { dir: tmpDir(), all: true });

		report(spawnEvent("member#1", false));
		report({ type: "status", id: "member#1", status: "working" });
		report({ type: "post", id: "member#1", post: { id: "p1", from: "member#1", kind: "tell", text: "hello", at: 1 } });
		report(closeEvent("member#1"));
		await settle();

		const closed = calls.filter((call) => call.method === "pane.close");
		assert.equal(closed.length, 2, "the member's pane and the board's");
		assert.equal(
			methods().filter((method) => method === "pane.release_agent").length,
			1,
			"only the member ever had an agent reported on it",
		);
	});

	test("a split that was asked for and never opened says so, with what herdr answered", async () => {
		const told: { message: string; level: string }[] = [];
		const { send } = recorder(null);
		const report = createHerdrReporterWith(send, { dir: tmpDir(), notify: (message, level) => void told.push({ message, level }) });

		report(spawnEvent("scout#1", true));
		report(spawnEvent("scout#2", true));
		await settle();

		assert.equal(told.length, 1, "three subagents that failed to open have one cause between them");
		assert.equal(told[0]?.level, "warning");
		assert.match(told[0]?.message ?? "", /no split opened for scout#1/);
		assert.match(told[0]?.message ?? "", /agent.start answered .*"agent":\{\}/, "what came back, verbatim");
	});

	test("and one that opened says which pane it is in, once", async () => {
		const told: string[] = [];
		const { send } = recorder("wD:p7");
		const report = createHerdrReporterWith(send, { dir: tmpDir(), notify: (message) => void told.push(message) });

		report(spawnEvent("scout#1", true));
		report(spawnEvent("scout#2", true));
		await settle();

		assert.deepEqual(told, ["herdr: splits are opening - scout#1 is in pane wD:p7"]);
	});

	test("a transport that answers nothing at all is said to have answered nothing", async () => {
		const told: string[] = [];
		const silent: HerdrSend = async () => undefined;
		const report = createHerdrReporterWith(silent, { dir: tmpDir(), notify: (message) => void told.push(message) });

		report(spawnEvent("scout#1", true));
		await settle();

		assert.match(told[0] ?? "", /the socket did not answer/);
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

describe("watching every subagent", () => {
	test("all: true opens a split for a subagent that never asked", () => {
		const { send, calls } = recorder();
		const reporter = createHerdrReporterWith(send, { dir: tmpDir(), all: true });

		reporter(spawnEvent("scout#1", false));
		assert.equal(calls.filter((call) => call.method === "agent.start").length, 1);
	});

	test("without it, opt-in still governs - a fan-out must not carpet the screen", () => {
		const { send, calls } = recorder();
		const reporter = createHerdrReporterWith(send, { dir: tmpDir() });

		reporter(spawnEvent("scout#1", false));
		reporter(spawnEvent("scout#2", true));
		assert.equal(calls.filter((call) => call.method === "agent.start").length, 1);
	});

	test("watching everything is off unless it is asked for", () => {
		const off = recorder();
		createHerdrReporterWith(off.send, { dir: tmpDir() })(spawnEvent("scout#1", false));
		assert.equal(off.calls.length, 0, "no ambient switch turns this on");

		const on = recorder();
		createHerdrReporterWith(on.send, { dir: tmpDir(), all: true })(spawnEvent("scout#1", false));
		assert.ok(on.calls.some((call) => call.method === "agent.start"));
	});
});

describe("combineReporters", () => {
	test("feeds every reporter, in order", () => {
		const first: string[] = [];
		const second: string[] = [];
		const report = combineReporters(
			(event) => first.push(event.type),
			(event) => second.push(event.type),
		);

		report(spawnEvent("scout#1", true));
		assert.deepEqual(first, ["spawn"]);
		assert.deepEqual(second, ["spawn"]);
	});

	test("drops absent reporters, so createHerdrReporter() can be passed straight in", () => {
		const seen: string[] = [];
		const report = combineReporters(undefined, (event) => seen.push(event.type), undefined);

		report(spawnEvent("scout#1", true));
		assert.deepEqual(seen, ["spawn"]);
	});

	test("one reporter throwing does not stop the others", () => {
		const seen: string[] = [];
		const report = combineReporters(
			() => {
				throw new Error("broken");
			},
			(event) => seen.push(event.type),
		);

		assert.doesNotThrow(() => report(spawnEvent("scout#1", true)));
		assert.deepEqual(seen, ["spawn"]);
	});

	test("combining nothing is a no-op, not a crash", () => {
		assert.doesNotThrow(() => combineReporters()(spawnEvent("scout#1", true)));
		assert.doesNotThrow(() => combineReporters(undefined)(spawnEvent("scout#1", true)));
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

	test("a delegated subagent is written under the one that asked for it", () => {
		const lines: string[] = [];
		const report = consoleReporter({ write: (line) => lines.push(line) });

		report(spawnEvent("explorer#1", false));
		report(spawnEvent("scout#1", false, "explorer#1"));
		report({ type: "tool", id: "scout#1", name: "grep", args: {} });
		report(closeEvent("scout#1"));

		assert.match(lines[0] as string, /^\n⏳ explorer#1/);
		assert.match(lines[1] as string, /^\n {2}⏳ scout#1/);
		assert.match(lines[2] as string, /^ {2} {3}· scout#1/);
		assert.match(lines[3] as string, /^ {2}✓ scout#1/);
	});

	test("a board reads as a board: who said what, who was handed what, who holds what", () => {
		const lines: string[] = [];
		const report = consoleReporter({ write: (line) => lines.push(line) });

		report({ type: "read", id: "member#1", posts: [], waiting: 0 });
		report({
			type: "post",
			id: "member#1",
			post: { id: "p1", from: "member#1", to: "member#2", kind: "ask", text: "Who is holding\nconsole.ts?", at: 12 },
		});
		report({ type: "read", id: "member#2", posts: ["p1"], waiting: 2 });
		report({ type: "claim", id: "member#2", key: "console.ts", action: "take", ok: true });
		report({ type: "claim", id: "member#1", key: "console.ts", action: "take", ok: false, heldBy: "member#2" });
		report({ type: "claim", id: "member#2", key: "console.ts", action: "release", ok: true });

		assert.match(lines[0] as string, /member#1 was handed nothing$/, "the quiet half, and the one a race needs");
		assert.match(lines[1] as string, /member#1 → member#2 \[ask\] Who is holding console.ts\?$/);
		assert.match(lines[2] as string, /member#2 was handed 1 post, 2 waiting$/);
		assert.match(lines[3] as string, /member#2 take console.ts → granted$/);
		assert.match(lines[4] as string, /member#1 take console.ts → refused \(member#2\)$/);
		assert.match(lines[5] as string, /member#2 release console.ts → given back$/);
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

describe("recordReporter", () => {
	test("one JSON line per event, in the order they happened", () => {
		const file = path.join(tmpDir(), "events.jsonl");
		const report = recordReporter(file);

		report(spawnEvent("scout#1", false));
		report({ type: "tool", id: "scout#1", name: "grep", args: { pattern: "auth" } });
		report({ type: "text", id: "scout#1", delta: "found it" });
		report(closeEvent("scout#1"));

		const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(
			lines.map((one) => one.type),
			["spawn", "tool", "text", "close"],
		);
		assert.equal(lines[1].name, "grep");
		assert.deepEqual(lines[1].args, { pattern: "auth" }, "recorded verbatim, never summarised");
		assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/, "our timestamp: pi has no notion of one");
	});

	test("the interleaving is what it adds: two subagents in one file", () => {
		const file = path.join(tmpDir(), "events.jsonl");
		const report = recordReporter(file);

		report(spawnEvent("scout#1", false));
		report(spawnEvent("scout#2", false));
		report({ type: "tool", id: "scout#2", name: "read", args: {} });
		report({ type: "tool", id: "scout#1", name: "grep", args: {} });

		const ids = fs
			.readFileSync(file, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line).id);
		assert.deepEqual(ids, ["scout#1", "scout#2", "scout#2", "scout#1"]);
	});

	test("the directory is created on the first event", () => {
		const file = path.join(tmpDir(), "deep", "nested", "events.jsonl");
		recordReporter(file)(spawnEvent("scout#1", false));
		assert.ok(fs.existsSync(file));
	});

	test("a write that cannot happen is swallowed: an observer never takes a run down", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, "blocked"), "");
		// A file where a directory would have to be: mkdir fails with ENOTDIR.
		const report = recordReporter(path.join(dir, "blocked", "events.jsonl"));

		assert.doesNotThrow(() => report(spawnEvent("scout#1", false)));
		assert.doesNotThrow(() => report(closeEvent("scout#1")));
	});
});
