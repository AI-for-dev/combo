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
import { runBuild, runInterview, type BuildDeps, type CommandCtx } from "../extension/build.ts";
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
