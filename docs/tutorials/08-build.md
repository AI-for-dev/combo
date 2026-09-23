# Reading code is not running it

![Reading code is not running it](../_static/tutorials/08-build.svg)

```{note}
This page was captured before flows replaced the linear pipeline. `/build` is
`/run build` now, its flags are keys of the [`build` flow](../reference/flows/build.md),
and a file left in `pipelines/` is refused; see [Deliver a change](../guide/build.md)
and [From pipelines to flows](../guide/from-pipelines.md). The frames and the
files below predate that change.
```

A pair once wrote a helper and its tests. The reviewer approved. The auditor,
reading the whole, approved. The test file imported `./slugify.js` for a file
named `slugify.ts`, and the suite never loaded. Both agents had read the code.
Neither had run it, and nothing in either prompt would have made them: a model
reading `import "./slugify.js"` sees a plausible line.

`/build` is the flow from a sentence to a working tree with the change in it,
and nobody is asked anything on the way. The one thing it insists on is that
your own check runs before anyone signs.

## Give it a check

The shipped pipeline has no `verify`, because it cannot know what your
project's check is. For one run, say it on the command line:

```
/build --check "npm test" add a slugify helper with tests
```

For every run, say it in a file, `.pi/pipelines/build.md`, which replaces the
shipped one by having the same name:

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

`verify` is a list, never a command line, and the check runs through
`execFile` with **no shell**, so `"npm test && rm -rf /"` in that list is one
argument and not two commands. `--check` is split on whitespace and on nothing
else: typed there, `&&` is an argument to `npm`. The flag beats the file's
`verify:` when both are given; with neither, no check runs and nobody asks for
one.

## Run it

In a throwaway clone:

```
/build --check "npm test" add a slugify helper with tests
```

The request is the brief, as typed. Nothing asks you to confirm it, nothing
asks for a check halfway through, and nothing asks for a commit at the end: a
question in the middle of a run is a run waiting for whoever left it going.
A sentence is a thin brief, though. When the request needs thinking through
first, `/interview` asks the questions only you can answer and hands back a
brief; that is the text to give `/build`.

Everything that can be refused is refused before the first subagent spawns: an
unknown pipeline, an agent nobody has, a model that does not resolve, and a
directory that is not a repository:

```
Error: build: this is not a git repository - nothing could show or undo what the run wrote
```

## What runs

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
`check FAILED, NOT approved` in those words when it does. Measured on a run
against a small open-weight model: the pair converged, the check caught a
failing test, the auditor named the fix, the fix ran, the check ran again, and
the run ended `NOT approved` rather than shipping something broken. That last
part is the machinery working, on a worker that could not.

## What it leaves

The work, in the working tree, uncommitted, as the pairs left it. `git diff`
shows exactly what the run did, and you decide what reaches history after
reading it. Nothing is committed, pushed or undone on your behalf.

## Interrupt it

Every step is written to `runs/<timestamp>/build.json`. Close the terminal in
the middle of the second pair and come back:

```
/build resume
build: carrying on runs/<timestamp>, 1/2 subtasks already approved
```

It says what it picked up rather than asking: typing `/build resume` was the
answer.

Only approved subtasks survive: one still being argued over left the tree in a
state nobody signed off on, so it runs again. Every obligation survives, open
or closed, keeping its id. The plan is reused, never re-made. Nothing of the
conversation survives: agents are stored by name and resolved again, and the
resumed build re-reads the code rather than replaying a transcript.

## Two things this page did not do

It did not put a pipeline that only reads through `/build`. Its answer would
end up in `runs/` rather than in front of a model that could take the next
question about it; `/run` is for that. And it did not say where the two
coders were writing while they ran at once, which is the whole of the next
page: a plan of several subtasks does not hand them one tree.

**Next:** [Two coders, one tree](09-two-coders-one-tree.md).
