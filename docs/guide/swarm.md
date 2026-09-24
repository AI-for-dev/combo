# Swarms

Every other combinator decides who does what. `fanOut` hands out the subtasks, a
planner writes them in `orchestrate`, `chain` fixes the order. A swarm decides
none of it: the members are told the same goal, handed a board to talk on and a
set of claims to take work from, and what they divide between them is theirs.

```typescript
const board = createBoard();
const done = await swarm({
	members: [{ agent: member, count: 3 }],
	goal: "Between you, describe every file under src/reporters/, two sentences each.",
	claims: createClaims({ keys: files }),
	until: (posted) => described(posted).size >= files.length,
	onEvent: consoleReporter(),
	board,
});
```

It is the one combinator whose worth is an open question rather than a design,
so it is built to lose honestly: **with no board, no claims and one round, a
swarm is a fan-out**. That degenerate case is a test in the suite and the
control arm of any run you make with it.

## A member

A member is an ordinary agent whose `tools:` names `board`. Nothing else marks
it out, and an agent that does not name the tool is handed nothing, exactly as
with `subagent`:

```markdown
---
name: member
description: Works one job beside other members, taking what it will do rather than being given it
tools: read, grep, find, ls, board
lifetime: workflow
---
```

`lifetime` defaults to `"workflow"` here and nowhere else. A member that forgets
the last round cannot build on what it saw, and `"task"` with more than one
round is refused outright: a member's id is its name on the board, and a
task-lifetime member gets a new one every round.

Each round, a member is handed the goal, whatever is new on the board for it,
and what is still free to take. It is **handed** rather than made to fetch: once
something arbitrates, members stop reading the board altogether, and charging
them a call to learn what the workflow already knows is charging them for its
bookkeeping.

## Taking, rather than announcing

A member can post a `claim` saying what it is working on, and that settles
nothing. Three members read a board within 130ms of each other, all three were
handed nothing because nobody had posted yet, and all three claimed the same
file. `createClaims` arbitrates instead: first to ask holds it, everyone else is
refused and told who holds it.

```text
   ⚑ member#1 take src/reporters/console.ts → granted
   ⚑ member#3 take src/reporters/console.ts → refused (member#1)
```

A refusal with nobody named is a different refusal: the key is not on the list,
or the member is already at `maxPerMember`.

## Running one

`examples/15-swarm.ts` is three members describing the seven files under
`src/reporters/`, read-only, with one claim per file:

```bash
node examples/15-swarm.ts --model <provider/model>              # board and claims
node examples/15-swarm.ts --model <provider/model> --control    # neither: a fan-out
node examples/15-swarm.ts --model <provider/model> --hold 1     # one key at a time
```

## What running it says

Three arms, one run each, three members and seven files, on one small
open-weight model:

| arm | files described | results posted | wall | ↑input |
| --- | --- | --- | --- | --- |
| control: no claims | 7 of 7 | 7 | 65.6s | 66k |
| board and claims | 7 of 7 | 14 | 138.5s | 222k |
| `--hold 1` | 7 of 7 | 8 | 76.8s | 167k |

Every arm answered the question, and the cheapest one was the arm with nothing
arbitrating. Three things are worth more than the table:

**One member can take the whole job.** Unbounded, `member#1` was granted all
seven keys in the first seconds and the other two were refused everything they
asked for. Nothing in the mechanism bounds how much one member may hold, and
telling a member in its prompt to take one thing at a time has been measured and
changes nothing. `maxPerMember` is the knob that does, and it is not the default
because taking, releasing and being refused are all calls.

What the locked-out members did instead is the board doing its job rather than a
repair: one of them wrote to the holder.

```text
   ✉ member#3 → member#1 [ask] Could you please release some of the reporters so…
```

**A claim governs the announcement, not the act.** In the same run, the member
that had been refused all seven keys described all seven files anyway. A member
holding `read` reads whatever it likes, whatever it holds, which is invariant 7
in its own words: a prompt is not a permission boundary, and a claim is not one
either. Use the toolset and a [worktree](worktree.md) for what must not happen,
and claims for who is doing what.

**A released key looks free again.** With `--hold 1` the members cycle through
take, describe, release, and a file somebody has already finished is free for
the next member to take and redo. Claims have no notion of done, and that is a
gap a run wanting one file done exactly once will find.

Run to run, one arm varies more than the arms differ from each other: the middle
row ran twice, 7 results in 65.8s the first time and 14 in 138.5s the second. So
the table is what three runs did, not a measurement of anything.

On work this tractable, a board is a cost with nothing to buy, and that is the
result rather than a disappointment. The [investigation these mechanisms are
modelled on](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/)
found the same thing from the other end: of the tasks its agents were given, the
ones with no legitimate solution produced about 93% of the traffic on their
board. Coordination came out of work that could not be done.

## From inside pi

```
/swarm --members 3 --claim src/reporters/console.ts,src/reporters/silent.ts,src/reporters/record.ts --hold 1 describe each file you take, in two sentences, and post a result naming it
```

The members appear above the prompt while they work, `ctrl+↑↓` walks them and
`ctrl+del` stops the selected one, `esc` stops all of them. What comes back is a
**step of the chain**, drawn in the transcript and kept out of the model's
context: a board pasted into a session would turn the window into an
orchestrator, and it is long. `/quote` is the door into the conversation and
`/step --from` carries it on, exactly as for [a chain walked by
hand](chain-by-hand.md).

`--claim` is what turns announcing into holding. It also gives the run something
to be finished by: with things named, the swarm stops when each of them has been
reported on. Measured in a real pi on the line above, three members and three
files:

| | rounds | turns | posts |
| --- | --- | --- | --- |
| round cap alone | 3 | 9 | 6, three of them describing a file already described |
| stopping when the named things are done | 1 | 3 | 7 |

A round cap bounds the worst case; it is not a plan. Without `--claim` there is
nothing to be done with, so the members run their rounds and stop.

### Stopping on agreement

`--claim` finishes a run by coverage, which is what a job that splits has to
reach. A job that does not split has no coverage: put three members on one
question and what ends it is the three of them saying the same thing.

```
/swarm --members 3 --until agree which programming language should a new backend service be written in
```

`--until agree` appends one sentence to the goal, asking each member to post its
answer as `VOTE: <answer>` on a line of its own, and stops the run when every
member's latest vote says the same. The instruction is written where the votes
are counted, because a stop condition that depends on a format nobody was told
about never fires, and one told in one place and read in another drifts.

Only a `result` counts as a vote, and `--until agree` lets a member post one
`result` a turn (`resultsPerTurn: 1` in code). A second one is refused, and the
member is told to end its turn, because what the others answer reaches it at
the top of the next one. A `tell` is always free: that is where a member thinks
aloud. Without the cap, one member on gemma-4-31b read an empty board and
posted its vote again seven times in the first round. The next round the other
two were handed mostly that one vote, and came round to it.

It reads the roster rather than whoever spoke: two members of three that agree
have not agreed, and a member that dropped out never lets it fire, so the run
spends its rounds and comes back `stopped by rounds`. Reaching a cap is not
success here either.

The two compose, and a debate wants both: `--claim Python,Rust,Go --hold 1`
hands out the opening positions one owner at a time, `--until agree` ends it.
A camp is an opening rather than a verdict, and the vote is free every round.
`examples/16-debate.ts` is that run in code, with `--same` as the arm that hands
out no camps.

Measured in a real pi on the line above, three members and one question:

| | rounds | turns | how it ended |
| --- | --- | --- | --- |
| round cap alone | 3 | 9 | stopped by rounds, on three prose answers nobody counted |
| `--until agree` | 1 | 3 | converged, on the first vote each of them cast |

What the same three members converged *on* is the thing to read before
believing a debate happened. Given the run above, all three read the repository
they were standing in and voted TypeScript, which is agreement about a fact
rather than an argument anybody won. Copies of one model share its opinion, so
a swarm asked for a debate has to be given its disagreement: that is what the
claims are for, and a run where nobody ever changed a vote is the control arm
saying nothing was at stake.

`/herdr on` before it gives every member its own split and the board a pane of
its own, which is the only view where the exchange reads as an exchange. See
[Display](display.md).

`--agent` takes any agent, and one that does not name `board` in its `tools:`
is run anyway with a word about it: its copies cannot reach each other, which
makes the run a fan-out, and that is the arm this whole page is measured
against.

## Containment

A swarm shipped without these reproduces the parts of that incident worth
avoiding.

- **A writer gets a copy of the repository.** `WorkflowOptions.cwd` is one
  string, so members share a directory by default. Four subagents in one
  directory, each told only to write a file and list what it saw, read all three
  others' secrets in one turn without being asked to look. See
  [Worktrees](worktree.md).
- **Tools stay an allowlist per agent.** A member that must not write gets no
  `write` and no `edit`.
- **No network.** combo grants none, and a swarm is the last place to start.
- **Every cap has a default.** `rounds` is 3, `concurrency` 4, the board's own
  limits are 200 posts of 2000 characters, 50 per member.
- **A member cannot repeat itself.** A post with the same kind, reader and text
  as one the member already made is refused, and the refusal names the earlier
  post.
- **A run can be stopped.** `esc` in the extension, an `AbortSignal` from code.

## What is deliberately absent

No signing, because identity is stamped rather than claimed and there is nothing
to forge. No file transfer over the board: a post carries text, files move
through the filesystem where the worktree governs them. No coded roles, lanes or
leader election, because whether those emerge is the question.

## See also

- [Workflows](workflows.md) for the combinator beside the other nine.
- [Display](display.md) for what the board looks like while it runs.
- [Design decisions](../decisions.md) for why the board is append-only and why a
  claim is granted rather than announced.
