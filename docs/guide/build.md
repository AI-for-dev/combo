# Deliver a change

The combinators compose into one flow, driven from pi by `/build`. What runs is
a [pipeline](pipelines.md) - a Markdown file you can replace with your own,
without touching any code:

```
/build --check "npm test" add a cache in front of the agent loader

  locate      a scout maps the code the request touches
  plan        who does what, validated before anything spawns
  pair        a worker and a reviewer per subtask, until accepted
  check       your own command runs; its verdict is final
  audit       one agent reads the whole, names what still has to change
```

**It asks nothing.** The request is the brief, the check comes from `--check` or
from the pipeline, and a run left alone runs to its end. It ends with the work
in the working tree, **uncommitted**, and one line saying what it amounted to.
You decide what reaches history after reading the diff: nothing is committed,
pushed or undone for you.

A brief worth building from is still worth writing: `/interview` turns a vague
request into one, and what it hands back is the text to give `/build`.

## The interview

`/interview` is its own command, and `/build` does not open with it.

```typescript
const { brief, answers } = await interview({ agent: interviewer, input: request, ask });
```

`ask` is a port: a select card in pi, `readline` in an example, a scripted array
in the tests, which is how a conversation with a human is replayed offline.

One question at a time, because a good second question depends on the first
answer. Returning `undefined` from `ask` is the **submit**, not a cancel: what
was already answered still counts, and the brief is still written. `esc` maps to
it for the same reason, and while a card is up that is the only thing `esc`
does: the run's stop key is held for as long as somebody is being asked, or the
interviewer that has to write the brief would go with the press. See
[Display](display.md#stopping-what-you-are-watching).

The interviewer's lifetime defaults to `"workflow"`. An interview *is* a
conversation, and a `"task"` interviewer would forget the answer it just received
and ask around it forever.

A label and its description share one line of the card, and pi-tui cuts what
does not fit without an ellipsis: on a 120-column terminal an option ended
`…before r`, and nothing on screen said a word was missing. `questionPrompt`
therefore asks for a label under 30 characters and a description under 60. It
belongs there and not in `agents/interviewer.md`, because the width is the
card's and the rule has to reach an interviewer you wrote yourself.

## The language of the interview

The header, the questions, the options and the specification come back in the
language of the request. `/interview ajoute un cache` is answered in French,
header included: it is drawn above the question on the same card, and left
unnamed in the instruction it came back English over a French question.

Handed to `/build`, the specification travels to the planner, the coder, the reviewer and the
auditor, whose prompts are English. That is deliberate: the person correcting the
spec before anything is built on it is the one who has to read it exactly, and a
model takes a request in any language.

## The delivery

From a script:

```typescript
import { commandVerifier, deliver } from "@ai-for-dev/combo";

const built = await deliver({
	planner,
	workers: [coder],
	reviewer,
	auditor,
	brief,
	verify: commandVerifier({ cwd, command: "npm", args: ["test"] }),
});
built.approved;      // the auditor signed off, nothing it raised is open, the check passed
built.obligations;   // what it raised, and what became of each
```

Defaults worth knowing: `concurrency` is **2**, not 4, because these workers
write to the same working tree; `maxRounds` inside a pair is 3; audit cycles
default to 2; `maxTasks` defaults to 8.

## Delivering in copies

Each subtask gets a copy of the repository. The pairs write there, and what they
wrote is applied to `cwd` one patch at a time with the check run between them,
so a patch that breaks the tree is named rather than bisected.

```typescript
const built = await deliver({ /* … */ cwd, verify });
built.landings;   // one entry per batch: what went in, and what stopped it
```

**That is the default from two subtasks up**, and not for the reason you would
expect. Two writers in one directory are not only a race: they are a channel.
Measured, four subagents given one directory each read the other three's files
inside a single turn, without being asked to look. One subtask has nobody to
leak to, so it writes where it was told - which is what `/build` on your own
repository is for.

`worktree: true` and `worktree: false` are both obeyed as written; left unsaid,
the delivery decides after planning, the first moment the number of writers is
known. From pi that is `--worktree` and `--worktree=false`, on `/build`, `/run`
and `/step`.

A delivery that chose the copies itself checks **first** that they can come
back, and stops with the reason if not: a tree with changes already in it
cannot take a landing, and finding that out after two subtasks have run is
paying for work twice. Asked for explicitly, nothing is second-guessed and the
failure lands where it always did.

`approved` gains a third condition with the copies: work that never reached the
tree is not delivered, whatever the auditor thought of the reports.

`concurrency` stays at 2 either way. What changes is the reason for that number:
with copies the limit is what a run costs rather than what one working tree can
take, so a caller can raise it on that basis.

A delivery lands twice or more: once for the planned subtasks, then once per
round of audit fixes. Only the first meets a tree it did not write, and the
later ones say so, or the option would stop working the moment an audit asked
for anything.

All of that is one decision, taken once before any work runs: `settling()`
answers whether the pairs are isolated, puts a batch's work back, and keeps
what became of each landing. A delivery asks it, rather than each place a batch
of pairs finishes deciding for itself.

**It does not combine with `resume` yet.** A resumed delivery starts on a tree
that holds what landed in a previous process, which is not the same as one it
filled itself, and it has no record of what that was. The landing refuses it,
and the refusal says so in those words.

## What the auditor still owes

An auditor whose `tools:` names `verdict` decides through that tool, and each
fix line it puts in `raised` becomes an obligation with an id. Later rounds list
the open ones and ask it what became of each. An auditor that holds no such tool
still signs with `APPROVED` on a line of its own.

So `approved` needs three things now: the auditor signed off, nothing it raised
is still open, and the check passed. A run that stops short names the ids that
are left rather than only saying it stopped.

**An id nobody raised costs nothing but itself.** Measured: an auditor with
nothing open answered `approved: true` with `resolved: [{ id: "coder" }]`, an id
it invented. The tool used to refuse the call outright, the auditor repeated the
same id and then gave up into prose, and the delivery ended unapproved with no
fix and no reason on screen. The unknown id is now dropped and named back beside
`Recorded: approved.`, so the decision survives the bookkeeping. Nothing is
closed that was not open, here or in the ledger.

[Workflows](workflows.md) covers the same mechanism inside a pair, and
[Design decisions](../decisions.md) has the reasoning.

## Reading code is not running it

`verify` is not a precaution. Without it, a pair once wrote a helper and its
tests, the reviewer approved, the auditor approved, and the test file imported
`./slugify.js` for a file named `slugify.ts`. The suite never even loaded. Both
agents had read the code.

**When a check is configured, its verdict is final.** No approval turns a failing
check into a success.

```typescript
commandVerifier({ cwd, command: "npm", args: ["test"] });
```

From pi, `--check "npm test"` names it for one run and a pipeline's `verify:`
for every run of that file; the flag wins when both are there. With neither, no
check runs and the audit is the only bar: nobody is asked for one, because a
question in the middle of a run is a run waiting for whoever left it going.

The command runs through `execFile` with **no shell**: arguments are a list, so
`"npm test && rm -rf /"` is an argument, not two commands. `--check` is split on
whitespace and on nothing else, so the same holds for what you type. Its output is
evidence the agents read and cannot argue with. The **tail** is kept rather than
the head, because a test runner says what failed at the end.

**A passing check travels with the fixes it contradicts.** Measured: the check
passed with four green tests, the auditor wrote "test file has a syntax error
causing failure" and raised a fix for it, and a round went into rewriting a file
that was fine. The auditor was holding that output in its own prompt. Reading
the auditor's prose for claims about the check and dropping those would throw
away real remarks on a guess, so the evidence goes out with the work instead:
every audit fix carries the line that the check passes on the tree it is about
to change, and a worker sent after a failure that is not there can settle it by
reading. A *failing* check is not repeated, because it is what the fix is for
and the suite says so the moment it runs.

## Why nothing is committed

A commit is a decision about the work, and whoever takes it has to have read
it. A stop that asked for that decision, or one that asked to confirm the brief
first, would mean a build that cannot run with nobody there. So the work stays
where the pairs left it, and `git diff` shows exactly what the run did.

This is also why `/build` still refuses a directory that is not a git
repository: nobody watches the run write, and git is how its work gets read
and, if need be, undone.

## Carrying on after an interruption

Every step is written to `runs/<timestamp>/build.json`, so a Ctrl+C, a dropped
connection or a closed terminal costs nothing that was already paid for.

```
/build resume
build: carrying on runs/<timestamp>, 2/3 subtasks already approved
```

It says what it picked up rather than asking: `/build resume` is already the
answer.

What survives, and why:

- **Only approved subtasks.** One still being argued over left the tree in a
  state nobody signed off on, so it runs again. Approval is the only claim from
  a previous life worth trusting.
- **Every obligation, open and closed.** An obligation that was open when the
  run stopped is still open, and the resumed run keeps its id rather than
  raising a duplicate. A build that forgot them would sign off on work nobody
  finished.
- **The plan is reused, never re-made.** Re-planning would re-split work that is
  already half done on disk, and the plan was paid for.
- **Nothing of the conversation.** Agents are stored by name and resolved again;
  the messages are dropped. A resumed build re-reads the code rather than
  replaying a transcript, which is also what keeps the file small enough to write
  after every step.
- **A state whose agents no longer exist is refused whole.** Dropping the steps
  that no longer resolve would silently drop work.
- **The audit rounds already spent stay spent, whole.** Each round comes back
  with its verdict, the check as it stood and what its fixes produced, so the
  resumed cycle reads the history it lived. Resuming continues the cycle, it
  does not restart it.

## Choosing the pipeline

`/build` runs the pipeline named `build` if you have written one, in
`~/.pi/agent/pipelines/` or in `.pi/pipelines/`, and a built-in default
otherwise - the flow described above, expressed as data. Another one by name:

```
/build --pipeline audit check what the parser does with an empty file
```

A `build.md` that does not parse is **refused**, never silently replaced by the
default: a file sitting right there and quietly not being used is worse than an
error. `/pipelines` lists what is loaded and what does not parse.

For a pipeline that only reads, use `/run` instead: its answer lands in the
conversation. See [Pipelines](pipelines.md).

## Why these are commands, not tools

A question card owns the terminal until it is answered, and nobody can answer a
question asked inside a model's turn, so `/interview` is a command. `/build`
asks nothing, and is one because a build is a run you start, stop with `esc`
and carry on with `/build resume`, not a call a model makes on your behalf.

## Reference

- [`workflows/interview`](../reference/api/workflows/interview.md), [`workflows/pair`](../reference/api/workflows/deliver/pair.md), [`workflows/deliver`](../reference/api/workflows/deliver/deliver.md), [`workflows/audit`](../reference/api/workflows/deliver/audit.md)
- [`ask`](../reference/api/ask.md) - `AskUser`, `Question`, `Answer`, `scriptedAsk`.
- [`verify`](../reference/api/verify.md) - `Verify`, `commandVerifier`.
- [`git/git`](../reference/api/git/git.md) - the git a pipeline may do.
- [`workflows/deliver/settle`](../reference/api/workflows/deliver/settle.md) - `settling`, how the work reaches the tree.
- [`resume`](../reference/api/workflows/deliver/resume.md) - `build.json`, what survives and what deliberately does not.
