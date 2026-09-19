# Reading code is not running it

![Reading code is not running it](../_static/tutorials/08-build.svg)

A pair once wrote a helper and its tests. The reviewer approved. The auditor,
reading the whole, approved. The test file imported `./slugify.js` for a file
named `slugify.ts`, and the suite never loaded. Both agents had read the code.
Neither had run it, and nothing in either prompt would have made them: a model
reading `import "./slugify.js"` sees a plausible line.

`/build` is the flow from a vague sentence to a commit, and the one thing it
insists on is that your own check runs before anyone signs.

## Give it a check

The shipped pipeline has no `verify`, because it cannot know what your
project's check is. Say so in a file, `.pi/pipelines/build.md`, which replaces
the shipped one by having the same name:

```markdown
---
name: build
description: Locate the code, split the work, implement it in pairs, check it, audit the whole
verify: [npm, test]
steps:
  - id: locate
    chain: scout
  - id: work
    deliver: planner
    workers: [coder]
    reviewer: reviewer
    auditor: auditor
    maxTasks: 6
    concurrency: 2
    maxRounds: 3
    maxAuditRounds: 2
---

## locate
Find the code the brief below touches. Report file:line for each place, and
nothing else - no plan, no opinion on what should change. What you miss here,
the planner will not know exists.

## work
Deliver the brief below, using the scout's report as the map of where things
live. Every subtask must be independently applicable to the working tree: when
the work is sequential, it is one subtask, not three.
```

`verify` is a list, never a command line. Splitting `"npm test"` on whitespace
is writing a small shell, and the check runs through `execFile` with **no
shell** so that `"npm test && rm -rf /"` is one argument and not two commands.

## The interview

In a throwaway clone:

```
/build add a slugify helper with tests
```

The interviewer reads the repository first, then asks. This is the first card
it drew, on `ilaas/gemma-4-31b`, after reading the code for half a minute:

```
[Separator preference]
What character should separate words in the slug?
→ Hyphen (-)                      Standard kebab-case used for URLs (e.g., 'hello-world').
  Underscore (_)                  Standard snake_case often used for filenames or identifiers (e.g., 'hello_world').
  Other…                          type your own answer
  That's enough - build it        stop asking and write the brief
↑↓ choose • enter answer • esc build with what you have
```

One card at a time, two to four concrete options with the recommended one
first, and two standing entries under them: **Other…** for an answer of your
own and **That's enough - build it** to stop asking. What you already answered
counts, and the brief is written from it.

The card's last line says `esc` means the same as that second entry. In this
run it did not:

```
Error: interview failed: stopped - the transcript is in /…/runs/2026-09-19_10-44-59
```

Since a run became stoppable from the keyboard, `esc` stops every subagent of
it, the interviewer included, and the interviewer is who writes the brief. Two
meanings for one key, and the stop won. Until that is fixed, choose the entry
rather than pressing the key. What the failure did right is the second half of
the line: a failed interview leaves its transcript in the run's folder, made
before the first question so that "what was actually sent" has an answer even
when nothing else does.

One question at a time because a good second question depends on the first
answer. Only about what you alone can decide: a preference, a constraint, a
trade-off. Never about what it could find out by reading the code, because it
reads the code between questions instead; the separator is a question about
your taste, and nothing in the repository answers it. Six questions at most,
`--questions 3` caps it lower, `--model` picks who asks.

Ask in French and the questions come in French. The brief too, and that is the
document you are about to correct, so it is in your language; the planner, the
coder and the auditor take it from there in theirs.

## The first stop

```
Brief - edit it if it got anything wrong
```

The brief opens in an editor, then a confirm: **Build this?**, with the first
lines of it. Refuse, and it stays in the prompt editor for you to send however you like;
nothing has been spawned. Of the two stops this is the cheap one and the one
worth spending time at: everything downstream is built against this text and
nobody will be there to ask a question.

## What runs between the stops

The scout maps the code. Then the planner splits the brief into subtasks and
assigns each to a worker, and the plan is validated against the roster before
anything spawns: an unknown name fails here, not three steps later. Then a
**pair** per subtask, a coder and a reviewer arguing until the reviewer's
verdict is yes and its ledger is empty, two pairs at a time, each in a copy of
the repository when there is more than one.

Then your check. The tail of its output, because a test runner says what
failed at the end, is handed to the auditor as evidence it can read and cannot
argue with.

Then the **audit**: one agent reads the whole, which nobody else has seen,
looking for the part of the brief nobody took, the thing done twice under two
names, two subtasks that contradict each other, and work reported as done that
the code does not show. Each fix it raises becomes an obligation; a coder takes
it; the check runs again. Two rounds at most.

The last line of a run that went through reads:

```
<n> subtasks, <n> audits, check passed, approved - exported to runs/<timestamp>
```

**When a check is configured, its verdict is final.** No approval anywhere in
that chain turns a failing check into a success, and the run says
`check FAILED, NOT approved` in those words when it does. Measured on a run against `ilaas/qwen-3.6-35b-instruct`:
the pair converged, the check caught a failing test, the auditor named the fix,
the fix ran, the check ran again, and the run ended `NOT approved` rather than
shipping something broken. That last part is the machinery working, on a
worker that could not.

## The second stop

The committer reads the brief and the diff and writes a message. It has **no
bash**. It holds `read`, `grep`, `find`, `ls`, and nothing else: it cannot run
git, and it was never asked not to. The commit itself is made by our code,
which has `add`, `commit`, `checkout -b` and no `push`, `reset`, `rebase` or
`--force`. The message is piped to `git commit -F -`, so a message containing
`rm -rf /` is committed as text.

```
Commit message - edit it, or empty it to skip the commit
Commit on combo/add-a-slugify-helper-with-tests?
```

Refuse, and the work stays in the working tree, uncommitted, as the pairs left
it. Nothing is undone on your behalf, at either stop.

## Interrupt it

Every step is written to `runs/<timestamp>/build.json`. Close the terminal in
the middle of the second pair and come back:

```
/build resume
Carry on? 1/3 subtasks already approved
```

Only approved subtasks survive: one still being argued over left the tree in a
state nobody signed off on, so it runs again. Every obligation survives, open
or closed, keeping its id. The plan is reused, never re-made. Nothing of the
conversation survives: agents are stored by name and resolved again, and the
resumed build re-reads the code rather than replaying a transcript.

## Two things this page did not do

It did not put a pipeline that only reads through `/build`. You would be
interviewed about a request that wants no decision and then told there is
nothing to commit; `/run` is for that. And it did not say where the two
coders were writing while they ran at once, which is the whole of the next
page: a plan of several subtasks does not hand them one tree.

**Next:** [Two coders, one tree](09-two-coders-one-tree.md).
