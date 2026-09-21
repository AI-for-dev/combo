/**
 * `/swarm`, with the whole of the work injected.
 *
 * Two properties are worth a test here and the rest follows from them: what the
 * swarm was actually asked for (how many members, with what to claim), and
 * where its answer went. A board pasted into the conversation would be
 * invisible in a terminal and would change what the session does next, which is
 * the same reason `/step` is tested this way.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { BOARD_TOOL } from "../src/board-tool.ts";
import { createBoard } from "../src/board.ts";
import type { StepDeps } from "../extension/deps.ts";
import { currentChain, forgetChain, type StepEntry } from "../extension/relay.ts";
import { quoteStep } from "../extension/commands/step.ts";
import { runSwarm, swarmAnswer, swarmLine } from "../extension/commands/swarm.ts";
import { emptyUsage } from "../src/usage.ts";
import type { SwarmOptions, SwarmResult } from "../src/workflows/swarm.ts";
import { fakeCtx } from "./fixtures/command-ctx.ts";
import { baseDeps } from "./fixtures/command-deps.ts";
import { testAgent } from "./fixtures/fake-subagent.ts";

initTheme();

const member = testAgent("member", { description: "One of several", tools: ["read", BOARD_TOOL] });
const scout = testAgent("scout", { description: "Reads code", tools: ["read"] });

const runs = mkdtempSync(join(tmpdir(), "combo-swarm-cmd-"));
after(() => rmSync(runs, { recursive: true, force: true }));

/** One member, one answer, and whatever the caller passed, kept for the assertions. */
function deps(over: Partial<SwarmResult> = {}) {
	const asked: SwarmOptions[] = [];
	const entries: StepEntry[] = [];
	const sent: { content: string }[] = [];

	const injected: StepDeps = {
		...baseDeps([member, scout], [], runs),
		appendEntry: (_customType, data) => void entries.push(data),
		sendMessage: (message) => void sent.push({ content: message.content }),
		swarm: (async (options: SwarmOptions) => {
			asked.push(options);
			const members = Array.from({ length: options.members[0]?.count ?? 0 }, (_one, index) => ({
				id: `member#${index + 1}`,
				agent: "member",
				result: { agent: "member", output: `member#${index + 1} did its part`, messages: [], usage: emptyUsage(), ok: true },
			}));
			return {
				members,
				posts: [],
				claims: [],
				rounds: 1,
				usage: { ...emptyUsage(), turns: members.length },
				converged: true,
				stoppedBy: "until",
				ok: true,
				...over,
			} as SwarmResult;
		}) as never,
	};

	return { deps: injected, asked, entries, sent };
}

beforeEach(forgetChain);

describe("/swarm", () => {
	test("puts several copies of one agent on one goal, and says so in the chain", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, asked, entries } = deps();

		const step = await runSwarm("--members 4 describe every file under src/reporters/", ctx, injected);

		assert.equal(asked[0]?.members[0]?.count, 4);
		assert.equal(asked[0]?.goal, "describe every file under src/reporters/");
		assert.equal(step?.kind, "swarm");
		assert.equal(entries[0]?.id, "member");
		assert.match(entries[0]?.output ?? "", /## member#4\n\nmember#4 did its part/);
	});

	test("the answer is drawn and not sent, and /quote is the way into the conversation", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, sent } = deps();

		await runSwarm("describe the reporters", ctx, injected);
		assert.equal(sent.length, 0, "a board in the context turns the window into an orchestrator");

		quoteStep("", ctx, injected);
		assert.match(sent[0]?.content ?? "", /member#1 did its part/);
	});

	test("--claim is what makes a claim a claim: named things, one owner each", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, asked } = deps();

		await runSwarm("--claim a.ts,b.ts --hold 1 describe them", ctx, injected);

		const claims = asked[0]?.claims;
		assert.deepEqual(claims?.free(), ["a.ts", "b.ts"]);
		assert.equal(claims?.take("member#1", "a.ts").ok, true);
		assert.equal(claims?.take("member#1", "b.ts").ok, false, "--hold 1 bounds what one member may hold");
		assert.equal(claims?.take("member#2", "c.ts").ok, false, "and a key nobody named is not a key");
	});

	test("a command wrapped before its last flag still carries it", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, asked } = deps();
		const checked: string[] = [];

		// What anybody writes once a command has six flags on it. The backslash
		// used to end the parse, so `--model` was read as the first two words of
		// the goal and the members ran on pi's own model with nothing said.
		const step = await runSwarm(
			"--members 3 --claim Python,Rust,Go --hold 1 \\\n       --model local/qwen\nQuel langage pour un service backend ?",
			ctx,
			{ ...injected, checkModel: async (pattern) => void checked.push(pattern) },
		);

		assert.equal(asked[0]?.model, "local/qwen");
		assert.deepEqual(checked, ["local/qwen"]);
		assert.equal(asked[0]?.goal, "Quel langage pour un service backend ?", "and the backslash is not part of what they are asked");
		assert.equal(step?.kind, "swarm");
	});

	test("a list written with spaces is caught, not half read", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, asked } = deps();

		const step = await runSwarm("--claim a.ts, b.ts describe them", ctx, injected);

		assert.equal(step, undefined, "half a list and a goal of `b.ts describe them` is the silent version");
		assert.deepEqual(asked, []);
		assert.match(said(), /comma-separated list with no spaces/);
	});

	test("with things named, it stops when they have all been reported on", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, asked } = deps();

		await runSwarm("--claim a.ts,b.ts describe them", ctx, injected);

		const until = asked[0]?.until;
		assert.ok(until, "a round cap is a bound on the worst case, not a plan");
		const board = createBoard();
		board.post("member#1", { kind: "result", text: "a.ts: it does a thing" });
		assert.equal(until(board), false, "b.ts is still nobody's answer");
		board.post("member#2", { kind: "claim", text: "taking b.ts" });
		assert.equal(until(board), false, "taking it is not reporting on it");
		board.post("member#2", { kind: "result", text: "b.ts: it does another" });
		assert.equal(until(board), true);
	});

	test("--until agree stops on the members saying one thing, and tells them how to say it", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, asked } = deps();

		await runSwarm("--members 3 --until agree which language for the backend", ctx, injected);

		assert.match(asked[0]?.goal ?? "", /VOTE: <your answer>/, "a stop condition nobody was told about never fires");
		const until = asked[0]?.until;
		assert.ok(until);
		const board = createBoard();
		board.post("member#1", { kind: "result", text: "VOTE: Rust" });
		board.post("member#2", { kind: "result", text: "VOTE: Go" });
		assert.equal(until(board), false, "two votes of three, and not the same one");
		board.post("member#2", { kind: "result", text: "VOTE: Rust" });
		assert.equal(until(board), false, "member#3 has not said anything yet");
		board.post("member#3", { kind: "result", text: "VOTE: Rust" });
		assert.equal(until(board), true);
	});

	test("claims hand out the sides and agreement ends it, which is one debate", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, asked } = deps();

		await runSwarm("--members 3 --claim Python,Rust,Go --hold 1 --until agree which one", ctx, injected);

		assert.ok(asked[0]?.claims, "the camps are still leased one owner at a time");
		const until = asked[0]?.until;
		assert.ok(until);
		const board = createBoard();
		for (const id of ["member#1", "member#2", "member#3"]) board.post(id, { kind: "result", text: "VOTE: Rust" });
		assert.equal(until(board), true, "reporting on a camp is not the others coming round to it");
	});

	test("a --until nobody recognises is refused rather than run on the round cap", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, asked } = deps();

		await runSwarm("--until consensus which language", ctx, injected);

		assert.equal(asked.length, 0);
		assert.match(said(), /--until takes "agree"/);
	});

	test("with nothing to claim the members are on their honour, as the library has it", async () => {
		const { ctx } = fakeCtx();
		const { deps: injected, asked } = deps();

		await runSwarm("describe the reporters", ctx, injected);

		assert.equal(asked[0]?.claims, undefined);
		assert.equal(asked[0]?.until, undefined, "with nothing named there is nothing to be done with");
	});

	test("an agent that does not name `board` runs, and is said to be a fan-out", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, asked } = deps();

		await runSwarm("--agent scout where is usage measured", ctx, injected);

		assert.equal(asked.length, 1, "a swarm that cannot talk is the control arm, not a mistake");
		assert.match(said(), /scout does not name `board`/);
		assert.match(said(), /fan-out/);
	});

	test("a count that is not one stops before anything is spawned", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, asked } = deps();

		const step = await runSwarm("--members two describe the reporters", ctx, injected);

		assert.equal(step, undefined);
		assert.deepEqual(asked, [], "nothing is spawned to discover a typo");
		assert.match(said(), /--members takes a whole number/);
	});

	test("with every member failed there is nothing to carry, and the chain stays as it was", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected } = deps({
			members: [{ id: "member#1", agent: "member", result: { agent: "member", output: "", messages: [], usage: emptyUsage(), ok: false, error: "no model" } }],
			ok: false,
			error: "no model",
		});

		const step = await runSwarm("describe the reporters", ctx, injected);

		assert.equal(step, undefined);
		assert.equal(currentChain()?.steps.length, 0);
		assert.match(said(), /every member failed - no model/);
	});

	test("a goal nobody typed is refused, because a swarm of nothing costs real tokens", async () => {
		const { ctx, said } = fakeCtx();
		const { deps: injected, asked } = deps();

		assert.equal(await runSwarm("  ", ctx, injected), undefined);
		assert.deepEqual(asked, []);
		assert.match(said(), /say what they are all on/);
	});
});

describe("what a swarm reports", () => {
	const done = (over: Partial<SwarmResult>): SwarmResult =>
		({
			members: [],
			posts: [],
			claims: [],
			rounds: 2,
			usage: { ...emptyUsage(), turns: 6 },
			converged: false,
			stoppedBy: "rounds",
			ok: true,
			...over,
		}) as SwarmResult;

	test("the line says how it ended, and reaching the cap is not converging", () => {
		const line = swarmLine("member", done({ members: [{ id: "member#1", agent: "member", result: { agent: "member", output: "x", messages: [], usage: emptyUsage(), ok: true } }] }));

		assert.match(line, /1 member, 2 rounds, 6 turns/);
		assert.match(line, /stopped by rounds/);
		assert.match(line, /nothing posted/);
	});

	test("a claim the swarm had to give back for a member is worth saying", () => {
		const line = swarmLine("member", done({ claims: [{ key: "a.ts", heldBy: "member#2", released: true }] }));

		assert.match(line, /1 claim released for a member that had stopped/);
	});

	test("the board is in the answer when there is one, and no heading over nothing when there is not", () => {
		const bare = swarmAnswer(done({ members: [{ id: "member#1", agent: "member", result: { agent: "member", output: "done", messages: [], usage: emptyUsage(), ok: true } }] }));
		assert.ok(!bare.includes("the board"));

		const talked = swarmAnswer(
			done({
				members: [{ id: "member#1", agent: "member", result: { agent: "member", output: "done", messages: [], usage: emptyUsage(), ok: true } }],
				posts: [{ id: "p1", from: "member#1", kind: "claim", text: "taking a.ts", at: 12 }],
			}),
		);
		assert.match(talked, /## the board\n\n.*taking a.ts/s);
	});
});
