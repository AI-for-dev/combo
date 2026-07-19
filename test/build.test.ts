/**
 * The `/build` and `/interview` commands, offline.
 *
 * Everything is injected: the agents, the interview, the delivery, the agent
 * that writes the commit message, and every git call. What is under test is the
 * wiring and the two stops - the brief before any work starts, the commit before
 * anything reaches history - because that is where the risk lives, not in the
 * combinators underneath.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { runBuild, runInterview, toggleHerdr, type BuildDeps, type CommandCtx } from "../extension/build.ts";
import { watchEverything, watchEverythingIs } from "../extension/execute.ts";
import { BUILD_STATE_VERSION, type BuildState } from "../src/resume.ts";
import { emptyUsage } from "../src/usage.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";
import { testTheme } from "./fixtures/theme.ts";

initTheme();

const agents = ["interviewer", "planner", "coder", "reviewer", "auditor", "committer"].map((name) =>
	testAgent(name, { description: `${name} for tests` }),
);

/** Records everything the command showed, and answers as the script says. */
function fakeCtx(answers: { confirm?: boolean[]; editor?: (string | undefined)[] } = {}) {
	const notes: { message: string; type?: string }[] = [];
	const confirms: string[] = [];
	const editors: string[] = [];
	const widgets: (string[] | undefined)[] = [];
	const statuses: (string | undefined)[] = [];
	let editorText = "";

	const confirmAnswers = [...(answers.confirm ?? [])];
	const editorAnswers = [...(answers.editor ?? [])];

	const ctx: CommandCtx = {
		cwd: "/repo",
		hasUI: true,
		ui: {
			theme: testTheme(),
			async custom<T>(): Promise<T> {
				throw new Error("the card must not be reached: the interview itself is injected");
			},
			async input() {
				return undefined;
			},
			notify: (message, type) => void notes.push({ message, type }),
			setStatus: (_key, text) => void statuses.push(text),
			setWidget: (_key, lines) => void widgets.push(lines),
			async editor(title, prefill) {
				editors.push(title);
				return editorAnswers.length ? editorAnswers.shift() : prefill;
			},
			async confirm(title) {
				confirms.push(title);
				return confirmAnswers.length ? Boolean(confirmAnswers.shift()) : true;
			},
			setEditorText: (text) => void (editorText = text),
		},
	};

	return { ctx, notes, confirms, editors, widgets, statuses, said: () => notes.map((note) => note.message).join("\n"), editorText: () => editorText };
}

const result = <T extends object>(over: T) => ({ usage: emptyUsage(), ok: true, ...over });

type Git = NonNullable<BuildDeps["git"]>;

/** A git double that says the tree is dirty and records what was done to it. */
function fakeGit(over: Partial<Git> = {}) {
	const calls: string[] = [];
	const git: Git = { ...workingTree(calls), ...over };
	return { git, calls };
}

function workingTree(calls: string[]): Git {
	return {
		isRepository: async () => true,
		status: async () => ({ ok: true as const, value: " M src/x.ts\n" }),
		diff: async () => ({ ok: true as const, value: "--- a/src/x.ts\n+++ b/src/x.ts\n+added\n" }),
		diffStat: async () => ({ ok: true as const, value: " src/x.ts | 1 +\n" }),
		untracked: async () => ["src/new.ts"],
		createBranch: async (_cwd: string, name: string) => {
			calls.push(`branch:${name}`);
			return { ok: true as const, value: name };
		},
		commitAll: async (_cwd: string, message: string) => {
			calls.push(`commit:${message}`);
			return { ok: true as const, value: "abc1234" };
		},
	};
}

/** The happy path's doubles: a brief, a delivery, a commit message. */
function deps(over: BuildDeps = {}): BuildDeps {
	return {
		loadAgents: () => agents,
		tickMs: 0,
		runDir: () => "/tmp/never-written",
		interview: async () => result({ brief: "THE BRIEF", answers: [], steps: [], submitted: false }) as never,
		deliver: async () =>
			result({ brief: "THE BRIEF", plan: [], planning: {} as never, tasks: [], audits: [], approved: true }) as never,
		run: async () => result({ agent: "committer", output: "Add x\n\nBecause.", messages: [] }) as never,
		...over,
	};
}

describe("/interview", () => {
	test("puts the brief in the editor, and hands it to the prompt", async () => {
		const { ctx, editors, editorText, said } = fakeCtx();
		const outcome = await runInterview("add a cache", ctx, deps());

		assert.equal(outcome?.brief, "THE BRIEF");
		assert.equal(editors.length, 1, "the brief is long: it belongs in an editor, not a notification");
		assert.equal(editorText(), "THE BRIEF", "sending it stays the user's decision");
		assert.match(said(), /brief ready/);
	});

	test("what the user edited is what comes back", async () => {
		const { ctx } = fakeCtx({ editor: ["A BETTER BRIEF"] });
		const outcome = await runInterview("add a cache", ctx, deps());
		assert.equal(outcome?.brief, "A BETTER BRIEF");
	});

	test("an empty request is refused before anything runs", async () => {
		const { ctx, said } = fakeCtx();
		let interviewed = false;
		await runInterview("   ", ctx, deps({ interview: (async () => ((interviewed = true), {})) as never }));

		assert.equal(interviewed, false);
		assert.match(said(), /say what you want built/);
	});

	test("outside an interactive session there is nobody to ask", async () => {
		const { ctx, said } = fakeCtx();
		const outcome = await runInterview("x", { ...ctx, hasUI: false }, deps());

		assert.equal(outcome, undefined);
		assert.match(said(), /nobody to ask/);
	});

	test("a missing interviewer says so instead of failing later", async () => {
		const { ctx, said } = fakeCtx();
		const outcome = await runInterview("x", ctx, deps({ loadAgents: () => [] }));

		assert.equal(outcome, undefined);
		assert.match(said(), /interviewer/);
	});

	test("a failed interview never invents a brief", async () => {
		const { ctx, said, editors } = fakeCtx();
		const outcome = await runInterview("x", ctx, deps({ interview: async () => result({ brief: "", ok: false, error: "boom" }) as never }));

		assert.equal(outcome?.ok, false);
		assert.equal(editors.length, 0);
		assert.match(said(), /interview failed: boom/);
	});
});

describe("/build", () => {
	test("interviews, asks before building, builds, then asks before committing", async () => {
		const { ctx, confirms } = fakeCtx();
		const { git, calls } = fakeGit();
		await runBuild("add a cache", ctx, deps({ git }));

		assert.deepEqual(confirms, ["Build this?", "Commit on pi-subagent/add-a-cache?"], "two stops, and only two");
		assert.deepEqual(calls, ["branch:pi-subagent/add-a-cache", "commit:Add x\n\nBecause."]);
	});

	test("refusing the brief stops before a single subagent is spawned", async () => {
		const { ctx, said } = fakeCtx({ confirm: [false] });
		let delivered = false;
		const { git, calls } = fakeGit();
		await runBuild("x", ctx, deps({ git, deliver: (async () => ((delivered = true), {})) as never }));

		assert.equal(delivered, false);
		assert.deepEqual(calls, [], "nothing was branched, nothing was committed");
		assert.match(said(), /stopped before any work started/);
	});

	test("refusing the commit leaves the work in the working tree", async () => {
		const { ctx, said } = fakeCtx({ confirm: [true, false] });
		const { git, calls } = fakeGit();
		await runBuild("x", ctx, deps({ git }));

		assert.deepEqual(calls, [], "no branch, no commit");
		assert.match(said(), /no commit - the work is in the working tree/);
	});

	test("emptying the message skips the commit: it is a way out, not an error", async () => {
		const { ctx, said } = fakeCtx({ editor: [undefined, "   "] });
		const { git, calls } = fakeGit();
		await runBuild("x", ctx, deps({ git }));

		assert.deepEqual(calls, []);
		assert.match(said(), /no commit/);
	});

	test("the message the user edited is the one committed", async () => {
		const { ctx } = fakeCtx({ editor: [undefined, "My own subject\n\nMy own body."] });
		const { git, calls } = fakeGit();
		await runBuild("x", ctx, deps({ git }));

		assert.deepEqual(calls, ["branch:pi-subagent/x", "commit:My own subject\n\nMy own body."]);
	});

	test("outside a git repository nothing starts: the work would have nowhere to land", async () => {
		const { ctx, said } = fakeCtx();
		let interviewed = false;
		const { git } = fakeGit({ isRepository: async () => false });
		await runBuild("x", ctx, deps({ git, interview: (async () => ((interviewed = true), {})) as never }));

		assert.equal(interviewed, false);
		assert.match(said(), /not a git repository/);
	});

	test("a clean tree after the build is reported, not committed as nothing", async () => {
		const { ctx, said } = fakeCtx();
		const { git, calls } = fakeGit({ status: async () => ({ ok: true as const, value: "" }) });
		await runBuild("x", ctx, deps({ git }));

		assert.deepEqual(calls, []);
		assert.match(said(), /nothing changed on disk/);
	});

	test("the committer reads the brief and the diff, not a summary of them", async () => {
		const prompts: string[] = [];
		const { ctx } = fakeCtx();
		const { git } = fakeGit();
		await runBuild("x", ctx, deps({
			git,
			run: (async (_agent: unknown, task: string) => {
				prompts.push(task);
				return result({ agent: "committer", output: "Subject", messages: [] });
			}) as never,
		}));

		assert.match(prompts[0] ?? "", /THE BRIEF/);
		assert.match(prompts[0] ?? "", /\+added/);
		assert.match(prompts[0] ?? "", /src\/new\.ts/, "untracked files are part of what gets committed");
	});

	test("a branch that already exists stops the commit rather than landing on it", async () => {
		const { ctx, said } = fakeCtx();
		const { git, calls } = fakeGit({ createBranch: async () => ({ ok: false as const, error: "branch exists" }) });
		await runBuild("x", ctx, deps({ git }));

		assert.deepEqual(calls, [], "and nothing was committed anywhere");
		assert.match(said(), /could not create/);
	});

	test("a delivery that was not approved still offers the commit, and says so", async () => {
		const { ctx, said } = fakeCtx();
		const { git, calls } = fakeGit();
		await runBuild("x", ctx, deps({
			git,
			deliver: async () =>
				result({ brief: "THE BRIEF", plan: [], planning: {} as never, tasks: [], audits: [], approved: false }) as never,
		}));

		assert.match(said(), /NOT approved/);
		assert.equal(calls.length, 2, "the user decides what to do with unapproved work - it is their tree");
	});

	test("the widget goes when the build ends, thrown or not", async () => {
		const { ctx, widgets } = fakeCtx();
		const { git } = fakeGit();
		await assert.rejects(() => runBuild("x", ctx, deps({ git, deliver: async () => { throw new Error("deliver exploded"); } })));

		assert.equal(widgets.at(-1), undefined, "no dead row of dots above the prompt");
	});

	test("the footer status is cleared whatever happens", async () => {
		const { ctx, statuses } = fakeCtx();
		const { git } = fakeGit();
		await runBuild("x", ctx, deps({ git }));

		assert.equal(statuses.at(-1), undefined);
	});
});

/** A state file for a build that stopped after one of two subtasks. */
function interrupted(over: Partial<BuildState> = {}): BuildState {
	return {
		version: BUILD_STATE_VERSION,
		request: "add a cache",
		brief: "THE OLD BRIEF",
		cwd: "/repo",
		startedAt: "2026-07-19T10:00:00.000Z",
		updatedAt: "2026-07-19T10:05:00.000Z",
		plan: [
			{ agent: "coder", task: "write the cache" },
			{ agent: "coder", task: "test the cache" },
		],
		tasks: [
			{
				agent: "coder",
				task: "write the cache",
				output: "done",
				ok: true,
				approved: true,
				rounds: 1,
				usage: emptyUsage(),
			},
		],
		audits: [],
		done: false,
		...over,
	};
}

describe("/build resume", () => {
	test("carries on the interrupted build: same brief, same plan, no second interview", async () => {
		const { ctx, confirms } = fakeCtx();
		const { git } = fakeGit();
		let interviewed = false;
		let resumed: unknown;

		await runBuild("resume", ctx, deps({
			git,
			findResumable: () => ({ dir: "runs/2026-07-19_10-00-00", state: interrupted() }),
			interview: (async () => ((interviewed = true), {})) as never,
			deliver: (async (options: { resume?: unknown; brief: string }) => {
				resumed = options.resume;
				assert.equal(options.brief, "THE OLD BRIEF", "the user does not re-decide what they decided an hour ago");
				return result({ brief: options.brief, plan: [], planning: {} as never, tasks: [], audits: [], approved: true });
			}) as never,
		}));

		assert.equal(interviewed, false);
		assert.match(confirms[0] ?? "", /Carry on\? 1\/2 subtask\(s\) already approved/);
		assert.equal((resumed as { plan: unknown[] }).plan.length, 2, "the plan it already paid for");
		assert.equal((resumed as { tasks: unknown[] }).tasks.length, 1);
	});

	test("writes into the directory the run started in, not a new one", async () => {
		const { ctx } = fakeCtx();
		const { git } = fakeGit();
		const saved: string[] = [];

		await runBuild("resume", ctx, deps({
			git,
			findResumable: () => ({ dir: "runs/2026-07-19_10-00-00", state: interrupted() }),
			runDir: () => "runs/a-brand-new-one",
			saveState: (dir) => (saved.push(dir), undefined),
			deliver: (async (options: { onProgress?: (p: unknown) => void }) => {
				options.onProgress?.({ plan: [], tasks: [], audits: [], done: false });
				return result({ brief: "b", plan: [], planning: {} as never, tasks: [], audits: [], approved: true });
			}) as never,
		}));

		assert.deepEqual(saved, ["runs/2026-07-19_10-00-00"], "one run, one folder");
	});

	test("progress is written as it goes, which is what makes resuming possible at all", async () => {
		const { ctx } = fakeCtx();
		const { git } = fakeGit();
		const states: BuildState[] = [];

		await runBuild("add a cache", ctx, deps({
			git,
			saveState: (_dir, state) => (states.push(state as BuildState), undefined),
			deliver: (async (options: { onProgress?: (p: unknown) => void }) => {
				options.onProgress?.({ plan: [], tasks: [], audits: [], done: false });
				options.onProgress?.({ plan: [], tasks: [], audits: [], done: true });
				return result({ brief: "b", plan: [], planning: {} as never, tasks: [], audits: [], approved: true });
			}) as never,
		}));

		assert.equal(states.length, 2);
		assert.equal(states[0]?.done, false);
		assert.equal(states[1]?.done, true, "a finished build is not offered for resuming");
		assert.equal(states[0]?.request, "add a cache");
	});

	test("nothing to carry on says so instead of starting a build nobody asked for", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		let delivered = false;

		await runBuild("resume", ctx, deps({
			git,
			findResumable: () => undefined,
			deliver: (async () => ((delivered = true), {})) as never,
		}));

		assert.equal(delivered, false);
		assert.match(said(), /no interrupted build/);
	});

	test("a state whose agents no longer exist is refused, not half-applied", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		let delivered = false;

		await runBuild("resume", ctx, deps({
			git,
			findResumable: () => ({ dir: "runs/x", state: interrupted({ plan: [{ agent: "ghost", task: "do magic" }] }) }),
			deliver: (async () => ((delivered = true), {})) as never,
		}));

		assert.equal(delivered, false);
		assert.match(said(), /no longer match/);
	});

	test("an unapproved run points at the way to carry it on", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		await runBuild("x", ctx, deps({
			git,
			deliver: async () =>
				result({ brief: "b", plan: [], planning: {} as never, tasks: [], audits: [], approved: false }) as never,
		}));

		assert.match(said(), /\/build resume/);
	});
});

describe("/herdr", () => {
	test("on and off, and the state is remembered between calls", () => {
		const { ctx, said } = fakeCtx();
		try {
			assert.equal(toggleHerdr("on", ctx), true);
			assert.equal(watchEverything(), true, "it is a session preference, not an argument");
			assert.equal(toggleHerdr("off", ctx), false);
			assert.equal(watchEverything(), false);
			// Outside herdr the "on" message is the warning; what matters here is
			// that the switch itself is remembered.
			assert.match(said(), /only the subagents that ask/);
		} finally {
			watchEverythingIs(false);
		}
	});

	test("no argument reports where it stands rather than toggling blindly", () => {
		const { ctx } = fakeCtx();
		try {
			toggleHerdr("on", ctx);
			assert.equal(toggleHerdr("", ctx), true, "asking must not flip it");
		} finally {
			watchEverythingIs(false);
		}
	});

	test("anything else is refused with the current state, not silently ignored", () => {
		const { ctx, said } = fakeCtx();
		assert.equal(toggleHerdr("maybe", ctx), false);
		assert.match(said(), /say on or off/);
	});

	test("outside herdr it says nothing will open, rather than pretending", () => {
		const { ctx, notes } = fakeCtx();
		try {
			toggleHerdr("on", ctx);
			// The suite does not run inside herdr, so this is the real path.
			assert.equal(notes.at(-1)?.type, "warning");
			assert.match(notes.at(-1)?.message ?? "", /not running inside herdr/);
		} finally {
			watchEverythingIs(false);
		}
	});
});
