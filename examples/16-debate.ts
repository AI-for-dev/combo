/**
 * Three debaters, one board, and nothing to divide between them.
 *
 *   node examples/16-debate.ts [--model <pattern>] [--camps Python,Rust,Go] [--members 3] [--rounds 6]
 *   node examples/16-debate.ts [--model <pattern>] --same          # the control arm
 *
 * `15-swarm.ts` is a swarm on work that splits: seven files, one claim each,
 * and the board exists to stop two members describing the same one. Here there
 * is nothing to split, so the board carries the work rather than the
 * bookkeeping: a turn that read nobody and answered nobody has produced an
 * opinion, not a debate.
 *
 * So this is the arm `15` does not have - an `until` reading the board for
 * agreement rather than for coverage. It stops when every member's latest
 * `VOTE:` line says the same thing, and a run that spends its rounds instead
 * comes back `converged: false`: agents out of turns have agreed on nothing.
 * The test and the sentence asking for the vote are the ones
 * `/swarm --until agree` uses, `agreed` and `VOTE_INSTRUCTION`, so the format
 * the members are told is the format that is counted.
 *
 * **The claims are what makes it a debate.** `--same` is the control, and it is
 * worth running once: given the question and no sides, three copies of one
 * model all voted for the same language in the first round, and the run
 * converged having argued nothing. Copies of one model share its opinion, so
 * the disagreement has to be handed to them. `15` claims files; this claims
 * positions, on the same first-to-ask terms, so a member refused its camp is
 * told who opened for it and takes another.
 *
 * A camp is an opening rather than a verdict: the vote is free every round, and
 * a member changing sides is what this run is watching for.
 *
 * `agents/debater.md` names `board` and nothing else, so the debate cannot
 * reach the filesystem it is running in.
 */

import {
	agreed,
	boardLines,
	createBoard,
	createClaims,
	formatUsage,
	latestVotes,
	swarm,
	VOTE_INSTRUCTION,
} from "../src/index.ts";
import { agent, consoleReporter, positional, repoRoot } from "./shared.ts";

const rounds = Number(flag("--rounds") ?? 6);
const same = positional.includes("--same");
const camps = (flag("--camps") ?? "Python,Rust,Go").split(",").map((one) => one.trim()).filter(Boolean);
const members = Number(flag("--members") ?? camps.length);

const board = createBoard();
const done = await swarm({
	members: [{ agent: agent("debater"), count: members }],
	goal: [
		"Which programming language should a new backend service be written in?",
		"",
		same
			? "Say which you would pick, and why that one rather than the one the others picked."
			: `Open for the language you take from the board - there are ${camps.length}: ${camps.join(", ")}.`,
		"",
		`There are ${members} of you and you have ${rounds} turns at most.`,
		"The point is not to win: it is to find the answer the others can also hold.",
		"",
		VOTE_INSTRUCTION,
	].join("\n"),
	rounds,
	board,
	// One camp each, arbitrated: three members told to pick a side pick the same
	// side, which is the race `createClaims` exists for one level down.
	...(same ? {} : { claims: createClaims({ keys: camps, maxPerMember: 1 }) }),
	// Agreement, not a tally of posts: a round where everybody restated their own
	// language changed nothing, and the cap is what catches that.
	until: agreed(members),
	cwd: repoRoot,
	onEvent: consoleReporter(),
	// pi's agent loop has no step cap; never run this unattended without one.
	timeoutMs: 300_000,
});

console.log(`\n──── the debate ────\n${board.all().length > 0 ? boardLines(board.all()) : "nobody said anything"}`);
console.log(`\n──── the last word of each ────`);
for (const [who, vote] of latestVotes(board.all())) console.log(`${who}: ${vote}`);
console.log(
	[
		`\n──── the run ────`,
		`rounds: ${done.rounds} of ${rounds}${same ? " (control: one question, no sides)" : ` (camps: ${camps.join(", ")})`}`,
		`converged: ${done.converged} (stopped by ${done.stoppedBy})`,
		`ok: ${done.ok}${done.error ? ` - ${done.error}` : ""}`,
		formatUsage(done.usage),
	].join("\n"),
);

/** A flag that takes a value, the way `shared.ts` reads `--model`. */
function flag(name: string): string | undefined {
	const at = positional.indexOf(name);
	return at >= 0 ? positional[at + 1] : undefined;
}
