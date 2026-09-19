/**
 * Three members on one job, and nobody dividing it.
 *
 *   node examples/15-swarm.ts [--model <pattern>] [--rounds 2] [--hold 1] [--control]
 *
 * Every other example hands out the work: `03-fan-out.ts` writes the subtasks,
 * `09-orchestrate.ts` has a planner write them. Here the three members are told
 * the same thing and left to it, with a board to talk on and one claim per file
 * under `src/reporters/`. Who does what is theirs to settle.
 *
 * `--control` is the arm to compare it against: no claims and one round, which
 * is a fan-out of the same three members on the same goal. The board's worth is
 * the difference between the two, on the job you actually have, and a run where
 * the control does as well is a result rather than a failure.
 *
 * `--hold <n>` bounds how much one member may hold at once, which is the third
 * arm and the one worth running second. Unbounded, a member that asks first can
 * take everything: whether it does is the model's, and the run says which
 * happened on its own timeline.
 *
 * Read-only throughout. `agents/member.md` names `read`, `grep`, `find`, `ls`
 * and `board`, so the swarm cannot write to the repository it is describing.
 */

import { readdirSync } from "node:fs";
import * as path from "node:path";
import {
	boardLines,
	createBoard,
	createClaims,
	formatUsage,
	heldList,
	swarm,
	type Post,
} from "../src/index.ts";
import { agent, consoleReporter, positional, repoRoot } from "./shared.ts";

const rounds = Number(flag("--rounds") ?? 2);
const hold = flag("--hold");
const control = positional.includes("--control");

// One key per file, taken from disk rather than typed out: a key that is not on
// the list is refused, so the list has to be what is really there.
const under = path.join("src", "reporters");
const files = readdirSync(path.join(repoRoot, under))
	.filter((name) => name.endsWith(".ts"))
	.map((name) => path.join(under, name))
	.sort();

const board = createBoard();
const claims = control ? undefined : createClaims({ keys: files, ...(hold ? { maxPerMember: Number(hold) } : {}) });

const done = await swarm({
	members: [{ agent: agent("member"), count: 3 }],
	goal: [
		`Between you, describe every file under ${under}/, in two sentences each.`,
		`There are ${files.length}: ${files.join(", ")}.`,
		"Describe the ones you were granted and no others, and post each description",
		"as a `result` whose first word is the path it is about.",
	].join(" "),
	rounds: control ? 1 : rounds,
	board,
	...(claims ? { claims } : {}),
	// Every file described, not merely as many results as there are files: three
	// members that all describe the same one have posted three results and
	// answered nothing. Reaching the round cap instead is not success, and
	// `converged` below is what says which of the two happened.
	until: (posted) => described(posted.all()).size >= files.length,
	cwd: repoRoot,
	onEvent: consoleReporter(),
	// pi's agent loop has no step cap; never run this unattended without one.
	timeoutMs: 300_000,
});

console.log(`\n──── the board ────\n${board.all().length > 0 ? boardLines(board.all()) : "nobody said anything"}`);
console.log(`\n──── what was held at the end ────\n${heldList(done.claims) || "nothing"}`);
console.log(
	[
		`\n──── the run ────`,
		`rounds: ${done.rounds}${control ? " (control: no claims, one round)" : hold ? ` (${hold} held at a time)` : ""}`,
		`converged: ${done.converged} (stopped by ${done.stoppedBy})`,
		`described: ${described(board.all()).size} of ${files.length}, in ${board.all().filter((post) => post.kind === "result").length} results`,
		`ok: ${done.ok}${done.error ? ` - ${done.error}` : ""}`,
		formatUsage(done.usage),
	].join("\n"),
);

/**
 * Which files a result has named, rather than how many results there are.
 *
 * Counting results would take three members describing one file for three files
 * done, which is the failure this whole arrangement is about.
 */
function described(posts: readonly Post[]): Set<string> {
	const seen = new Set<string>();
	for (const post of posts) {
		if (post.kind !== "result") continue;
		const named = files.find((file) => post.text.includes(file));
		if (named) seen.add(named);
	}
	return seen;
}

/** A flag that takes a value, the way `shared.ts` reads `--model`. */
function flag(name: string): string | undefined {
	const at = positional.indexOf(name);
	return at >= 0 ? positional[at + 1] : undefined;
}
