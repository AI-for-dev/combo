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
import { parseBuildArgs, runBuild, runInterview, toggleHerdr, type BuildDeps, type CommandCtx } from "../extension/build.ts";
import { parsePipeline } from "../src/pipeline.ts";
import { watchEverything, watchEverythingIs } from "../extension/run-ui.ts";
import { BUILD_STATE_VERSION, type BuildState } from "../src/resume.ts";
import type { DeliverResult } from "../src/workflows/deliver.ts";
import type { PipelineRunResult } from "../src/workflows/pipeline-run.ts";
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
	const inputs: string[] = [];
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
			async input(title: string) {
				inputs.push(title);
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

	return { ctx, notes, confirms, editors, widgets, statuses, inputs, said: () => notes.map((note) => note.message).join("\n"), editorText: () => editorText };
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

/** Stands in for the `build` pipeline the package ships. */
const shipped = parsePipeline(
	"---\nname: build\nsteps:\n  - id: work\n    deliver: planner\n    workers: [coder]\n    reviewer: reviewer\n    auditor: auditor\n---\n\n## work\nDeliver the brief.\n",
	"<shipped>/pipelines/build.md",
);

/**
 * A pipeline run that delivered, as the runner reports one.
 *
 * `/build` reads `approved`, the subtasks and the audits off the **delivery**
 * carried by the step, never off the step's text - so a double that returned
 * only text would test nothing the command actually does.
 */
function delivered(over: Partial<DeliverResult> = {}) {
	const delivery = result({
		brief: "THE BRIEF",
		plan: [],
		planning: {} as never,
		tasks: [],
		audits: [],
		approved: true,
		...over,
	}) as DeliverResult;
	return result({
		pipeline: "build",
		steps: [{ id: "work", kind: "deliver" as const, result: {} as never, delivery }],
		output: "done",
	}) as PipelineRunResult;
}

/** The happy path's doubles: a brief, a delivery, a commit message. */
function deps(over: BuildDeps = {}): BuildDeps {
	return {
		loadAgents: () => agents,
		loadPipelines: () => ({ pipelines: [shipped], broken: [] }),
		tickMs: 0,
		runDir: () => "/tmp/never-written",
		interview: async () => result({ brief: "THE BRIEF", answers: [], steps: [], submitted: false }) as never,
		runPipeline: async () => delivered(),
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

		assert.deepEqual(confirms, ["Build this?", "Commit on combo/add-a-cache?"], "two stops, and only two");
		assert.deepEqual(calls, ["branch:combo/add-a-cache", "commit:Add x\n\nBecause."]);
	});

	test("--model reaches the pipeline run", async () => {
		const { ctx } = fakeCtx();
		const { git } = fakeGit();
		let seen: string | undefined;
		await runBuild(
			"--model local/qwen add a cache",
			ctx,
			deps({
				git,
				checkModel: async () => {},
				runPipeline: (async (options: { model?: string }) => ((seen = options.model), delivered())) as never,
			}),
		);

		assert.equal(seen, "local/qwen");
	});

	test("a model that does not resolve costs a second, not an interview", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		let interviewed = false;
		const outcome = await runBuild(
			"--model local/nope x",
			ctx,
			deps({
				git,
				checkModel: async () => {
					throw new Error('No model found for "local/nope"');
				},
				interview: (async () => ((interviewed = true), {})) as never,
			}),
		);

		assert.equal(outcome, undefined);
		assert.equal(interviewed, false, "the check runs before anyone is asked anything");
		assert.match(said(), /No model found/);
	});

	test("refusing the brief stops before a single subagent is spawned", async () => {
		const { ctx, said } = fakeCtx({ confirm: [false] });
		let ran = false;
		const { git, calls } = fakeGit();
		await runBuild("x", ctx, deps({ git, runPipeline: (async () => ((ran = true), {})) as never }));

		assert.equal(ran, false);
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

		assert.deepEqual(calls, ["branch:combo/x", "commit:My own subject\n\nMy own body."]);
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
			runPipeline: async () => delivered({ approved: false }),
		}));

		assert.match(said(), /NOT approved/);
		assert.equal(calls.length, 2, "the user decides what to do with unapproved work - it is their tree");
	});

	test("the widget goes when the build ends, thrown or not", async () => {
		const { ctx, widgets } = fakeCtx();
		const { git } = fakeGit();
		await assert.rejects(() => runBuild("x", ctx, deps({ git, runPipeline: async () => { throw new Error("the pipeline exploded"); } })));

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

describe("/build and its pipeline", () => {
	test("with no pipeline of your own, the one the package ships runs", async () => {
		const { ctx } = fakeCtx();
		const { git } = fakeGit();
		let ran: string | undefined;

		await runBuild("add a cache", ctx, deps({
			git,
			runPipeline: (async (options: { pipeline: { name: string; filePath: string } }) => {
				ran = `${options.pipeline.name} from ${options.pipeline.filePath}`;
				return delivered();
			}) as never,
		}));

		assert.match(ran ?? "", /^build from .*pipelines\/build\.md$/, "the default is a file, not a constant");
	});

	test("the agents and the pipelines shipped here are asked for, at the lowest priority", async () => {
		const { ctx } = fakeCtx();
		const { git } = fakeGit();
		const asked: unknown[] = [];

		await runBuild("x", ctx, deps({
			git,
			loadAgents: (options) => (asked.push(options), agents),
			loadPipelines: (options) => (asked.push(options), { pipelines: [shipped], broken: [] }),
		}));

		// Both sources, and both asked for the built-ins: without that, `/build`
		// only works inside a repository that already has the definitions.
		assert.ok(asked.length >= 2);
		for (const options of asked) {
			assert.deepEqual(options, { cwd: "/repo", scope: "both", builtin: true });
		}
	});

	test("no pipeline named build anywhere says so, rather than inventing one", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		let ran = false;

		await runBuild("x", ctx, deps({
			git,
			loadPipelines: () => ({ pipelines: [], broken: [] }),
			runPipeline: (async () => ((ran = true), {})) as never,
		}));

		assert.equal(ran, false);
		assert.match(said(), /Unknown pipeline "build"/);
	});

	test("a build.md of your own replaces it, without touching the code", async () => {
		const { ctx } = fakeCtx();
		const { git } = fakeGit();
		let ran: string | undefined;
		const mine = parsePipeline(
			"---\nname: build\nsteps:\n  - id: look\n    chain: coder\n---\n\n## look\nGo.\n",
			"/somewhere/.pi/pipelines/build.md",
		);

		await runBuild("x", ctx, deps({
			git,
			loadPipelines: () => ({ pipelines: [mine], broken: [] }),
			runPipeline: (async (options: { pipeline: { filePath: string } }) => {
				ran = options.pipeline.filePath;
				return delivered();
			}) as never,
		}));

		assert.equal(ran, "/somewhere/.pi/pipelines/build.md");
	});

	test("--pipeline picks another one by name", async () => {
		const { ctx } = fakeCtx();
		const { git } = fakeGit();
		let ran: string | undefined;
		const audit = parsePipeline(
			"---\nname: audit\nsteps:\n  - id: look\n    chain: coder\n---\n\n## look\nGo.\n",
			"audit.md",
		);

		await runBuild("--pipeline audit check the parser", ctx, deps({
			git,
			loadPipelines: () => ({ pipelines: [audit], broken: [] }),
			runPipeline: (async (options: { pipeline: { name: string } }) => {
				ran = options.pipeline.name;
				return delivered();
			}) as never,
		}));

		assert.equal(ran, "audit");
	});

	test("a build.md that does not parse is refused, never silently replaced", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		let ran = false;

		await runBuild("x", ctx, deps({
			git,
			loadPipelines: () => ({
				pipelines: [],
				broken: [{ filePath: ".pi/pipelines/build.md", name: "build", error: 'needs a non-empty "steps" list.' }],
			}),
			runPipeline: (async () => ((ran = true), {})) as never,
		}));

		assert.equal(ran, false, "a file sitting right there must not be quietly ignored");
		assert.match(said(), /build\.md does not parse/);
	});

	test("an unknown --pipeline stops before the interview, not after it", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		let interviewed = false;

		await runBuild("--pipeline ghost x", ctx, deps({
			git,
			loadPipelines: () => ({ pipelines: [], broken: [] }),
			interview: (async () => ((interviewed = true), {})) as never,
		}));

		assert.equal(interviewed, false, "a typo costs a second, not a conversation");
		assert.match(said(), /Unknown pipeline "ghost"/);
	});

	test("a pipeline naming an agent nobody has is refused before the interview", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		let interviewed = false;
		const ghosts = parsePipeline(
			"---\nname: build\nsteps:\n  - id: look\n    chain: ghost\n---\n\n## look\nGo.\n",
			"build.md",
		);

		await runBuild("x", ctx, deps({
			git,
			loadPipelines: () => ({ pipelines: [ghosts], broken: [] }),
			interview: (async () => ((interviewed = true), {})) as never,
		}));

		assert.equal(interviewed, false);
		assert.match(said(), /Unknown agent "ghost"/);
	});

	test("the check a pipeline names is used instead of asking for one", async () => {
		const { ctx, inputs } = fakeCtx();
		const { git } = fakeGit();
		let verified: unknown;
		const withCheck = parsePipeline(
			"---\nname: build\nverify: [npm, test]\nsteps:\n  - id: look\n    chain: coder\n---\n\n## look\nGo.\n",
			"build.md",
		);

		await runBuild("x", ctx, deps({
			git,
			verify: undefined,
			loadPipelines: () => ({ pipelines: [withCheck], broken: [] }),
			runPipeline: (async (options: { verify?: unknown }) => ((verified = options.verify), delivered())) as never,
		}));

		assert.ok(verified, "the file states the project's bar once, so nobody has to retype it");
		assert.deepEqual(inputs, [], "and the user is not asked for a command they already wrote down");
	});
});

describe("parseBuildArgs", () => {
	test("a bare request stays a request", () => {
		assert.deepEqual(parseBuildArgs("build a cache"), { request: "build a cache" });
	});

	test("--pipeline takes the name, and leaves the rest alone", () => {
		assert.deepEqual(parseBuildArgs("--pipeline audit check the parser"), {
			pipeline: "audit",
			request: "check the parser",
		});
		assert.deepEqual(parseBuildArgs("--pipeline=audit x"), { pipeline: "audit", request: "x" });
	});

	test("a flag in the middle is part of the request: it is free text", () => {
		assert.deepEqual(parseBuildArgs("fix the --pipeline flag"), { request: "fix the --pipeline flag" });
	});

	test("--model takes a pattern, in either order with --pipeline", () => {
		assert.deepEqual(parseBuildArgs("--model local/qwen add a cache"), {
			model: "local/qwen",
			request: "add a cache",
		});
		assert.deepEqual(parseBuildArgs("--model local/qwen --pipeline audit x"), {
			model: "local/qwen",
			pipeline: "audit",
			request: "x",
		});
		assert.deepEqual(parseBuildArgs("--pipeline audit --model=local/qwen x"), {
			model: "local/qwen",
			pipeline: "audit",
			request: "x",
		});
	});

	test("an unknown leading flag is free text, not a swallowed argument", () => {
		assert.deepEqual(parseBuildArgs("--force the issue"), { request: "--force the issue" });
	});
});

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
			runPipeline: (async (options: { delivery?: { resume?: (id: string) => unknown }; input: string }) => {
				resumed = options.delivery?.resume?.("work");
				assert.equal(options.input, "THE OLD BRIEF", "the user does not re-decide what they decided an hour ago");
				return delivered();
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
			runPipeline: (async (options: { delivery?: { onProgress?: (id: string, p: unknown) => void } }) => {
				options.delivery?.onProgress?.("work", { plan: [], tasks: [], audits: [], done: false });
				return delivered();
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
			runPipeline: (async (options: { delivery?: { onProgress?: (id: string, p: unknown) => void } }) => {
				options.delivery?.onProgress?.("work", { plan: [], tasks: [], audits: [], done: false });
				options.delivery?.onProgress?.("work", { plan: [], tasks: [], audits: [], done: true });
				return delivered();
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
		let ran = false;

		await runBuild("resume", ctx, deps({
			git,
			findResumable: () => undefined,
			runPipeline: (async () => ((ran = true), {})) as never,
		}));

		assert.equal(ran, false);
		assert.match(said(), /no interrupted build/);
	});

	test("a state whose agents no longer exist is refused, not half-applied", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		let ran = false;

		await runBuild("resume", ctx, deps({
			git,
			findResumable: () => ({ dir: "runs/x", state: interrupted({ plan: [{ agent: "ghost", task: "do magic" }] }) }),
			runPipeline: (async () => ((ran = true), {})) as never,
		}));

		assert.equal(ran, false);
		assert.match(said(), /no longer match/);
		assert.match(said(), /ghost/, "the missing agent is named: the fix is to bring it back, or start over");
		assert.match(said(), /runs\/x/, "and so is the directory that state and its transcripts are in");
	});

	test("an unapproved run points at the way to carry it on", async () => {
		const { ctx, said } = fakeCtx();
		const { git } = fakeGit();
		await runBuild("x", ctx, deps({
			git,
			runPipeline: async () => delivered({ approved: false }),
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
