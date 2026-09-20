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
import { BOARD_PANE, createHerdrReporterWith, paneCommand } from "../src/reporters/herdr.ts";
import { detectHerdr, type HerdrSend } from "../src/reporters/herdr-client.ts";
import { probeHerdr } from "../src/reporters/herdr-probe.ts";
import type { SubagentEvent } from "../src/events.ts";
import { emptyUsage } from "../src/usage.ts";
import { withoutHerdr } from "./fixtures/no-herdr.ts";

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
 * "no pane id" test needs to exercise. Each split gets its own id, because a
 * run opens several and a shared one would hide who was being talked to.
 */
function recorder(paneId: string | null = "w1:p") {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	let opened = 0;
	const send: HerdrSend = async (method, params) => {
		calls.push({ method, params });
		if (method !== "pane.split") return { result: {} };
		return paneId === null ? { result: { pane: {} } } : { result: { pane: { pane_id: `${paneId}${++opened}` } } };
	};

	/** The file the pane named `label` was told to follow. */
	const logOf = (label: string) => {
		const pane = calls.find((call) => call.method === "pane.rename" && call.params.label === label)?.params.pane_id;
		const run = calls.find((call) => call.method === "pane.send_input" && call.params.pane_id === pane);
		return /'(.+)'/.exec(String(run?.params.text ?? ""))?.[1] as string;
	};

	return { send, calls, logOf, methods: () => calls.map((call) => call.method) };
}

/** A mirror socket nothing listens on: a reporter test opens no server. */
const NOWHERE = "/nowhere/combo.sock";

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
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir(), pane: "w1:p1" });

		report(spawnEvent("scout#1", true));
		await settle();

		assert.deepEqual(
			calls.map((call) => call.method),
			["pane.split", "pane.rename", "pane.send_input"],
			"herdr opens a pane at a prompt: the command is typed into it afterwards",
		);
		assert.equal(calls[0]?.params.direction, "right");
		assert.equal(calls[0]?.params.focus, false);
		assert.equal(calls[0]?.params.target_pane_id, "w1:p1", "beside ours, never beside whatever is focused");
		assert.equal(calls[1]?.params.label, "scout#1");
		assert.match(
			String(calls[2]?.params.text),
			/^exec '.+' '.+\/pane\/main\.ts' --socket '\/nowhere\/combo\.sock' --id 'scout#1'$/,
			"the pane hosts a client of the mirror, not the subagent",
		);
	});

	test("a subagent without openInHerdr produces no request at all", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

		report(spawnEvent("scout#1", false));
		report({ type: "tool", id: "scout#1", name: "grep", args: {} });
		report({ type: "status", id: "scout#1", status: "working" });
		report(closeEvent("scout#1"));
		await settle();

		assert.deepEqual(calls, [], "opt-in means opt-in");
	});

	test("the full life of a split: start, report, release, close", async () => {
		const { send, methods } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		await settle();
		report({ type: "status", id: "scout#1", status: "working" });
		await settle();
		report({ type: "status", id: "scout#1", status: "done" });
		await settle();
		report(closeEvent("scout#1"));
		await settle();

		assert.deepEqual(methods(), [
			"pane.split",
			"pane.rename",
			"pane.send_input",
			"pane.report_agent",
			"pane.report_agent",
			"pane.release_agent",
			"pane.close",
		]);
	});

	test('"done" is reported as idle: herdr\'s PaneAgentState has no done', async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		await settle();
		report({ type: "status", id: "scout#1", status: "done" });
		await settle();

		const reported = calls.find((call) => call.method === "pane.report_agent");
		assert.equal(reported?.params.state, "idle");
	});

	test("blocked and working pass through unchanged", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

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
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

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

	test("the pane runs on the node this process runs, and the client is where the package keeps it", () => {
		const command = paneCommand("scout#1", "/tmp/combo.sock");
		assert.ok(command.startsWith(`exec '${process.execPath}' '`), "the shell's node may be another version, or none");
		const main = /^exec '[^']+' '([^']+)'/.exec(command)?.[1] as string;
		assert.ok(fs.existsSync(main), `${main} must exist, or every pane opens on a usage error`);
		assert.match(command, / --socket '\/tmp\/combo\.sock' --id 'scout#1'$/);
	});

	test("the members talk on a pane of their own", async () => {
		const dir = tmpDir();
		const { send, logOf, calls } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir, all: true });

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

		const board = fs.readFileSync(logOf(BOARD_PANE), "utf8");
		assert.match(board, /⇣ member#2 was handed nothing/, "the quiet half is the one a race needs");
		assert.match(board, /✉ member#1 → member#2 \[ask\] who has console.ts\?/);
		assert.match(board, /⚑ member#2 take console.ts → refused \(member#1\)/);
		assert.match(String(calls.find((call) => call.method === "pane.send_input" && String(call.params.text).includes("board"))?.params.text), /^exec tail -n \+1 -f '/, "the board is the one pane that follows a file: nobody types to it");
	});

	test("a person's word reaches the pane through the mirror, and opens no board", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		report({ type: "steer", id: "scout#1", text: "look at test/ first" });
		await settle();

		assert.equal(calls.filter((call) => call.method === "pane.split").length, 1, "the board is what passed between members");
	});

	test("nobody watching means no board pane either", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

		report(spawnEvent("member#1", false));
		report({ type: "post", id: "member#1", post: { id: "p1", from: "member#1", kind: "tell", text: "hello", at: 1 } });
		await settle();

		assert.deepEqual(calls, [], "a board pane over a run with no panes is a window nobody asked for");
	});

	test("the board closes with the last member, and releases no agent it never had", async () => {
		const { send, calls, methods } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir(), all: true });

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
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		await settle();
		report({ type: "status", id: "scout#1", status: "working" });
		await settle();

		assert.deepEqual(methods(), ["pane.split"], "no pane id, nothing to name, run on or report on");
	});

	test("several subagents get independent splits", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

		report(spawnEvent("scout#1", true));
		report(spawnEvent("scout#2", true));
		await settle();

		assert.deepEqual(
			calls.filter((call) => call.method === "pane.rename").map((call) => call.params),
			[
				{ pane_id: "w1:p1", label: "scout#1" },
				{ pane_id: "w1:p2", label: "scout#2" },
			],
			"one pane each, named after the subagent it shows",
		);
	});

	test("events for an unknown id are ignored, not crashed on", async () => {
		const { send, calls } = recorder();
		const report = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

		assert.doesNotThrow(() => report({ type: "tool", id: "never-spawned#1", name: "grep", args: {} }));
		await settle();
		assert.deepEqual(calls, []);
	});
});

describe("probeHerdr", () => {
	/** A server that answers `answer` to everything, and remembers what it was asked. */
	const server = (answer: unknown) => {
		const calls: { method: string; params: Record<string, unknown> }[] = [];
		const send: HerdrSend = async (method, params) => {
			calls.push({ method, params });
			return answer;
		};
		return { send, calls };
	};

	test("a pane herdr cannot find means the request itself was understood", async () => {
		const { send, calls } = server({ error: { code: "pane_not_found", message: "pane not found" } });

		assert.equal(await probeHerdr(send), undefined);
		assert.equal(calls.length, 1, "asking must not open anything");
		assert.equal(calls[0]?.method, "pane.split");
		assert.equal(calls[0]?.params.direction, "right", "the probe sends what a run sends");
		assert.ok(calls[0]?.params.target_pane_id, "a pane that cannot exist is what makes it harmless");
	});

	test("any other refusal comes back in herdr's own words", async () => {
		const { send } = server({ error: { code: "invalid_request", message: "missing field `kind`" } });

		assert.equal(await probeHerdr(send), "herdr refused pane.split: missing field `kind`");
	});

	test("a herdr that answers nothing is not a herdr that agreed", async () => {
		const { send } = server(undefined);

		assert.equal(await probeHerdr(send), "herdr is not answering");
	});

	test("a herdr that splits anyway is told to close it again", async () => {
		const { send, calls } = server({ result: { pane: { pane_id: "w1:p9" } } });

		assert.equal(await probeHerdr(send), undefined, "panes open, which is the question that was asked");
		assert.deepEqual(
			calls.map((call) => call.method),
			["pane.split", "pane.close"],
			"a probe that leaves a pane behind is worse than no probe",
		);
	});

	test("a transport that throws is a reason, not a crash", async () => {
		const send: HerdrSend = async () => {
			throw new Error("socket gone");
		};

		assert.equal(await probeHerdr(send), "socket gone");
	});
});

describe("autoReporter", () => {
	test("falls back silently when herdr is absent", () => {
		const report = withoutHerdr(() => autoReporter());
		assert.doesNotThrow(() => report(spawnEvent("scout#1", true)));
	});

	test("uses the fallback it was given", () => {
		const seen: string[] = [];
		const report = withoutHerdr(() => autoReporter({ fallback: (event) => seen.push(event.type) }));

		report(spawnEvent("scout#1", true));
		assert.deepEqual(seen, ["spawn"]);
	});
});

describe("watching every subagent", () => {
	test("all: true opens a split for a subagent that never asked", () => {
		const { send, calls } = recorder();
		const reporter = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir(), all: true });

		reporter(spawnEvent("scout#1", false));
		assert.equal(calls.filter((call) => call.method === "pane.split").length, 1);
	});

	test("without it, opt-in still governs - a fan-out must not carpet the screen", () => {
		const { send, calls } = recorder();
		const reporter = createHerdrReporterWith(send, { mirror: NOWHERE, dir: tmpDir() });

		reporter(spawnEvent("scout#1", false));
		reporter(spawnEvent("scout#2", true));
		assert.equal(calls.filter((call) => call.method === "pane.split").length, 1);
	});

	test("watching everything is off unless it is asked for", () => {
		const off = recorder();
		createHerdrReporterWith(off.send, { dir: tmpDir() })(spawnEvent("scout#1", false));
		assert.equal(off.calls.length, 0, "no ambient switch turns this on");

		const on = recorder();
		createHerdrReporterWith(on.send, { dir: tmpDir(), all: true })(spawnEvent("scout#1", false));
		assert.ok(on.calls.some((call) => call.method === "pane.split"));
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

	test("a steer reads as a person's word to one subagent", () => {
		const lines: string[] = [];
		consoleReporter({ write: (line) => lines.push(line) })({ type: "steer", id: "scout#1", text: "look at test/ first" });
		assert.match(lines[0] as string, /⌨ scout#1 ← look at test\/ first$/);
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
