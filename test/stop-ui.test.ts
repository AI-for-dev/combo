import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { paintWidget } from "../extension/run-ui.ts";
import { forgetRun, isAsking, moveSelection, stopCommand, stoppable, watchRun, whileAsking, type KeyUi, type LiveRun } from "../extension/stop.ts";
import { emptyUsage, snapshotFrom, type SubagentSnapshot } from "../src/index.ts";

/** A subagent as the picture would have it. */
function one(id: string, status: SubagentSnapshot["status"] = "working", parentId?: string): SubagentSnapshot {
	return { id, agent: id.split("#")[0] as string, lifetime: "task", status, task: "x", tools: [], output: "", usage: emptyUsage(), parentId, depth: parentId ? 1 : 0 };
}

/** A run whose switch records what was asked of it, instead of stopping anything. */
function fakeRun(subagents: SubagentSnapshot[]) {
	const stopped: string[] = [];
	let all = 0;
	let repaints = 0;
	const run: LiveRun = {
		stop: {
			signal: new AbortController().signal,
			spawn: (() => {
				throw new Error("unused");
			}) as never,
			one(id: string) {
				const known = subagents.some((subagent) => subagent.id === id);
				if (known) stopped.push(id);
				return known;
			},
			all() {
				all++;
			},
		},
		snapshot: () => snapshotFrom(subagents),
		repaint: () => void repaints++,
	};
	return {
		run,
		stopped,
		get all() {
			return all;
		},
		get repaints() {
			return repaints;
		},
	};
}

/** A pi whose terminal input the test drives by hand. */
function fakeKeyUi() {
	let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let unlistened = 0;
	const ui: KeyUi = {
		onTerminalInput(next) {
			handler = next;
			return () => {
				handler = undefined;
				unlistened++;
			};
		},
	};
	return {
		ui,
		press: (data: string) => handler?.(data),
		get listening() {
			return handler !== undefined;
		},
		get unlistened() {
			return unlistened;
		},
	};
}

const notes: { message: string; type?: string }[] = [];
const ctx = { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void notes.push({ message, type }) } };
const ESCAPE = "\x1b";
const CTRL_DOWN = "\x1b[1;5B";
const CTRL_UP = "\x1b[1;5A";
const CTRL_DELETE = "\x1b[3;5~";

/** Whatever a test left watching would act on the next one's keys. */
const opened: LiveRun[] = [];
function open(subagents: SubagentSnapshot[], ui?: KeyUi) {
	const fake = fakeRun(subagents);
	watchRun(fake.run, ui);
	opened.push(fake.run);
	return fake;
}

afterEach(() => {
	for (const run of opened.splice(0)) forgetRun(run);
	notes.length = 0;
});

describe("stoppable", () => {
	test("lists what is still running, in the order the widget draws it", () => {
		const ids = stoppable(snapshotFrom([one("explorer#1"), one("scout#1", "done"), one("reader#1", "idle", "explorer#1")]));
		assert.deepEqual(ids, ["explorer#1", "reader#1"], "a finished subagent is not stoppable, a delegated one is");
	});
});

describe("the keys a live run listens to", () => {
	test("escape stops the run, and is passed on to pi rather than swallowed", () => {
		const keys = fakeKeyUi();
		const fake = open([one("scout#1")], keys.ui);

		const answer = keys.press(ESCAPE);

		assert.equal(fake.all, 1);
		assert.equal(answer?.consume, undefined, "pi's own interrupt must still fire: the turn goes with the subagents");
	});

	test("escape belongs to a question card while one is open, and to the run again after", async () => {
		const keys = fakeKeyUi();
		const fake = open([one("interviewer#1", "idle")], keys.ui);

		await whileAsking(async () => {
			assert.equal(isAsking(), true);
			keys.press(ESCAPE);
			assert.equal(fake.all, 0, "the card's esc must not stop the interviewer that writes the brief");
		});

		assert.equal(isAsking(), false);
		keys.press(ESCAPE);
		assert.equal(fake.all, 1);
	});

	test("a card that throws still gives escape back", async () => {
		await assert.rejects(whileAsking(async () => {
			throw new Error("card failed");
		}));
		assert.equal(isAsking(), false);
	});

	test("ctrl+↓ and ctrl+↑ walk the running subagents, and wrap", () => {
		const keys = fakeKeyUi();
		const fake = open([one("scout#1"), one("scout#2"), one("scout#3", "done")], keys.ui);

		assert.equal(keys.press(CTRL_DOWN)?.consume, true, "a selection key is ours, so it never reaches the editor");
		assert.equal(fake.run.selected, "scout#1");
		keys.press(CTRL_DOWN);
		assert.equal(fake.run.selected, "scout#2");
		keys.press(CTRL_DOWN);
		assert.equal(fake.run.selected, "scout#1", "a finished subagent is skipped, and the list wraps");
		keys.press(CTRL_UP);
		assert.equal(fake.run.selected, "scout#2");
		assert.ok(fake.repaints >= 4, "a moved selection is drawn at once, not at the next tick");
	});

	test("ctrl+del stops the selected subagent, which is what `/stop` says in words", () => {
		const keys = fakeKeyUi();
		const said: string[] = [];
		keys.ui.notify = (message) => void said.push(message);
		const fake = open([one("scout#1"), one("scout#2")], keys.ui);

		keys.press(CTRL_DOWN);
		assert.equal(keys.press(CTRL_DELETE)?.consume, true);

		assert.deepEqual(fake.stopped, ["scout#1"]);
		assert.match(said[0] as string, /scout#1 stopped/, "a key that says nothing looks like a key that did nothing");
	});

	test("a key nobody asked for is left alone", () => {
		const keys = fakeKeyUi();
		const fake = open([one("scout#1")], keys.ui);

		assert.equal(keys.press("a"), undefined);
		assert.equal(keys.press("\x1b[A"), undefined, "a plain arrow still belongs to the editor");
		assert.equal(fake.run.selected, undefined);
	});

	test("nothing is listened to outside a run", () => {
		const keys = fakeKeyUi();
		const fake = open([one("scout#1")], keys.ui);
		assert.equal(keys.listening, true);

		forgetRun(fake.run);
		opened.length = 0;

		assert.equal(keys.listening, false, "escape belongs to pi again the moment the run is over");
		assert.equal(keys.unlistened, 1);
	});

	test("two runs at once share one listener, and escape stops both", () => {
		const keys = fakeKeyUi();
		const first = open([one("scout#1")], keys.ui);
		const second = open([one("writer#1")], keys.ui);

		keys.press(ESCAPE);
		keys.press(CTRL_DOWN);

		assert.equal(first.all, 1);
		assert.equal(second.all, 1);
		assert.equal(second.run.selected, "writer#1", "the newest run is the one on screen, so it is the one a key moves");
		assert.equal(first.run.selected, undefined);
	});
});

describe("/stop", () => {
	test("says so when nothing is running", () => {
		assert.match(stopCommand("", ctx), /nothing is running/);
		assert.equal(notes[0]?.type, "warning");
	});

	test("stops the selected subagent and leaves the run going", () => {
		const fake = open([one("scout#1"), one("scout#2")]);
		moveSelection(1);
		moveSelection(1);

		const said = stopCommand("", ctx);

		assert.deepEqual(fake.stopped, ["scout#2"]);
		assert.equal(fake.all, 0, "stopping one branch is not stopping the run");
		assert.match(said, /scout#2 stopped/);
		assert.equal(fake.run.selected, undefined, "what was stopped is no longer the selection");
	});

	test("with a single subagent there is nothing to select", () => {
		const fake = open([one("scout#1")]);
		stopCommand("", ctx);
		assert.deepEqual(fake.stopped, ["scout#1"]);
	});

	test("with several running and none selected, it says how to pick one", () => {
		const fake = open([one("scout#1"), one("scout#2")]);

		const said = stopCommand("", ctx);

		assert.deepEqual(fake.stopped, []);
		assert.match(said, /scout#1, scout#2/);
	});

	test("an id names one directly, whichever run it belongs to", () => {
		const first = open([one("scout#1")]);
		open([one("writer#1")]);

		stopCommand("scout#1", ctx);

		assert.deepEqual(first.stopped, ["scout#1"]);
	});

	test("a subagent that has finished is refused, not reported as stopped", () => {
		const fake = open([one("scout#1", "done"), one("scout#2")]);

		const said = stopCommand("scout#1", ctx);

		assert.deepEqual(fake.stopped, [], "a finished subagent is nobody's to stop");
		assert.match(said, /no subagent `scout#1` is running/);
	});

	test("an unknown id is refused with the ids that would work", () => {
		const fake = open([one("scout#1")]);

		const said = stopCommand("ghost#9", ctx);

		assert.deepEqual(fake.stopped, []);
		assert.match(said, /no subagent `ghost#9`/);
		assert.match(said, /scout#1/);
	});

	test("all stops every live run", () => {
		const first = open([one("scout#1")]);
		const second = open([one("writer#1")]);

		stopCommand("all", ctx);

		assert.equal(first.all, 1);
		assert.equal(second.all, 1);
	});
});

describe("the widget while a run can be stopped", () => {
	const plain = { fg: (_colour: string, text: string) => text };

	test("the selected subagent is marked, and only that one", () => {
		const painted = paintWidget(snapshotFrom([one("scout#1"), one("scout#2")]), plain, "scout#2");

		assert.match(painted[0] as string, /^● scout#1/);
		assert.match(painted[2] as string, /^▸ scout#2/);
	});

	test("a selection the run has left behind is not marked", () => {
		const painted = paintWidget(snapshotFrom([one("scout#1", "done"), one("scout#2")]), plain, "scout#1");

		assert.match(painted[0] as string, /^✓ scout#1/, "what has finished cannot be stopped, so it is not pointed at");
	});

	test("the keys are spelled out while something is running, and not after", () => {
		const running = paintWidget(snapshotFrom([one("scout#1")]), plain);
		const over = paintWidget(snapshotFrom([one("scout#1", "done")]), plain);

		assert.match(running.at(-1) as string, /esc stops everything/);
		assert.ok(!(over.at(-1) as string).includes("esc"), "a finished run leaves no advice above the prompt");
	});
});
