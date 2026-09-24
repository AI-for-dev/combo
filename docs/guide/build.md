# Deliver a change

`/run build <request>` runs the shipped [`build` flow](../reference/flows/build.md)
on the request, from the request to a finished working tree. What runs is a
[flow](flows.md), a file you can read, copy and replace with your own, without
touching any code:

```
/run build make slugify lowercase the title, turn every run of characters that are not letters or digits into one dash, and trim dashes at both ends; add tests for it --model ilaas/gemma-4-31b

  locate      a scout maps the code the request touches
  plan        a planner splits it into subtasks, a typed list
  deliver     up to two rounds of:
    work        each subtask to a coder and a reviewer, in a copy of the repository
    tests       .pi/checks/test.sh, your project's own script
    audit       an auditor reads the whole change against the request
  report      a synthesiser tells you what was done and what is left
```

**It asks nothing.** The request is the brief, the check is a script of your
project, and a run left alone runs to its end. It ends with the work in the
working tree, **uncommitted**, and its answer in the conversation. You decide
what reaches history after reading the diff.

## What it needs

The run stage checks the project before the first spawn, and says what is
missing, one fault per line:

- **A git repository.** Each subtask works in a copy made from the tree, and
  the copies land back through git. Outside one, the run is refused at the
  block that makes them.
- **`.pi/checks/test.sh`.** The check is a script of your project, read before
  the run starts and run with `bash` after each round of work: what runs is
  what was read, whatever an agent does to the file. The shipped flow names
  that path, so a project without it is refused rather than audited on the
  reviewers' word.

```bash
#!/usr/bin/env bash
exec node --test
```

`--model` puts every agent turn on one model, and `--timeout` bounds one turn.
Nothing else is a flag: how many rounds, how many subtasks at once, whether
they get copies, what the check is, all of it is in the file.

## What you see

The widget draws the flow's plan as it fills, the visit running now expanded
with what its subagent is doing:

```
● build · 2 visits · 54s · ↑22k ↓1.9k
✓ locate · scout · 33s · ↑12k ↓831
✓ plan · planner · 10s · ↑9.8k ↓1.1k
● deliver · #1 of 2
  ● deliver#1
    ● deliver#1/work · 0/1 so far
      ● deliver#1/work[1]
        ● deliver#1/work[1]/pair · #1 of 3
          ● deliver#1/work[1]/pair#1
            ● deliver#1/work[1]/pair#1/code
              ● coder#1  grep /node/ in .  ilaas/gemma-4-31b · 11.2s
            ○ deliver#1/work[1]/pair#1/review · agent reviewer (.pi/agents/reviewer.md) · reads item.text, code, diff…
    ○ deliver#1/tests · check .pi/checks/test.sh · timeout 10m · ≤ 20m
    ○ deliver#1/audit · agent auditor (.pi/agents/auditor.md) · reads input, work, tests, diff, deliver.ledger · verd…
○ report · agent synthesiser (.pi/agents/synthesiser.md) · reads input, diff, deliver.output.last.work, deliver.outpu…
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

A subagent's line gives its tokens once its turn has ended, since that is when
pi's counters are read; the coder above is still in its first.

When it ends, its answer lands in the conversation: the output of its last
root node, `report`, a few lines a synthesiser wrote from the diff, how each
pair of the last round ended and the audit; then `ok · runs/<timestamp>`; then
the last frame:

```
Result of the build flow, asked to: make slugify lowercase the title, turn every run of characters that are not letters
or digits into one dash, and trim dashes at both ends; add tests for it.

The slugify function in slug.js now lowercases the title, replaces any sequence of non-alphanumeric characters with a
single dash, and trims dashes from both ends. A new test file, slug.test.js, was added to verify these behaviors.
Nothing remains to be done.

ok · runs/2026-09-24_01-06-54

✓ build · 12 visits · 2m19s · ↑69k ↓12k
✓ locate · scout · 33s · ↑12k ↓831
✓ plan · planner · 10s · ↑9.8k ↓1.1k
✓ deliver · 1 iteration · 1m32s · ↑45k ↓9.3k
✓ report · synthesiser · 5s · ↑2.1k ↓456
```

The report is written from the diff, so it names what a coder did beyond the
request too, a file nobody asked for included; it does not replace reading the
diff. A build that fails writes no report, and its end line says where and
why.

`git diff` shows exactly what the run did. The run directory holds each
subagent's transcript under the visit or the pair it served, and `usage.json`
with what every visit cost. See [Flows](flows.md#the-run-directory).

## How the work is judged

- **A pair is a coder and a reviewer who remember each other**, for three
  rounds at most. The reviewer decides through a verdict, reading the task,
  the coder's summary and the diff of the copy: the summary is a claim, the
  diff is the evidence. A review that ends in prose, with no `verdict` call,
  is sent back once with the failure named, and so is an audit. A pair that
  reaches three rounds unapproved still lands its work, marked not
  converged, and the audit reads that.
- **The check's verdict is final.** The round is over when the tests pass and
  the auditor approves; no approval turns a failing script into a success.
  Without it, a pair once wrote a helper and its tests, the reviewer approved,
  the auditor approved, and the test file imported `./slugify.js` for a file
  named `slugify.ts`. The suite never even loaded. Both agents had read the
  code.
- **What the audit raises becomes the next round's subtasks.** Each remark is
  an obligation with an id in the round's ledger, and the second round works on
  the ones nobody closed. There is no third: a build that ends its second round
  unapproved fails, and one whose ledger is empty with nothing approved gives
  up rather than running a round on nothing.

## Why nothing is committed

A commit is a decision about the work, and whoever takes it has to have read
it. So the work stays where the pairs landed it: the report says what to look
for, and `git diff` is what you read.

When you want the decision taken in the run, with somebody there,
`/run build-attended <request>` interviews you on the request, shows the
specification and asks "Build this?". Answered yes, it runs `build` on the
specification, has the committer write the message from the specification,
the build's report and the diff, and commits on the run's own branch. Our code
makes the commit; the committer has no tool that could.

## Carrying on after an interruption

Every fact of the run is appended to its journal as it happens, so a Ctrl+C,
a dropped connection or a closed terminal costs nothing that already ended.

```
/run resume
run: resuming build in runs/2026-09-23_20-21-17, from deliver#1/work[1]/pair#1/code
```

It says what it picked up rather than asking: typing it is already the answer.
That run was killed while its coder worked, and the coder's visit ran again,
in the copy it had left open. The summary counts both lives, the first marked
`partial` since it was killed before it could write its measurement:

```
✓ build · 9 visits · 1m51s · ↑43k ↓11k · 2 lives (1 partial) · resumed from deliver#1/work[1]/pair#1/code
```

Every visit that ended survives, the plan and each approved pair included, and
the first one that did not end runs again with fresh subagents, which re-read
the tree rather than a replayed conversation. A copy left open is taken back,
and one that is gone starts its subtask over. A run that failed by a decision
of its own, the second round unapproved or nothing left to hand round, would
decide the same again, and is refused with why. What else is refused, and how,
is [Resuming a run](flows.md#resuming-a-run).

## Your own build

A `build.md` in `~/.pi/agent/flows/` or `.pi/flows/` replaces the shipped one,
inside `build-attended` too. Copy the shipped file and change what you mean to:
the check's path, the number of rounds, the concurrency, the agents. A file
that does not check is refused with its faults, never silently replaced by the
shipped one; `/flows build` prints the plan it would run. A `build.md` left in
an old `pipelines/` directory is refused too, and [From pipelines to
flows](from-pipelines.md) says how to rewrite it.

## The interview

`/interview` is still a command of its own, and `build-attended` asks through
the `interview` flow, on the same card. One question at a time, because a good
second question depends on the first answer, and "That's enough" is a submit,
not a cancel: what was answered still counts, and the specification is still
written. The header, the questions and the specification come back in the
language of the request, and they travel on to the planner, the coders and the
auditor in it: the person correcting the specification is the one who has to
read it exactly, and a model takes a request in any language.

A label and its description share one line of the card, and pi-tui cuts what
does not fit without an ellipsis, so the interviewer is asked for a label under
30 characters and a description under 60.

## From a script

```typescript
import { bashCheck, checkFlow, checkRun, gitPort, loadFlowCatalogue, measuredRun, runFlow } from "@ai-for-dev/combo";

const flow = checkFlow("build", loadFlowCatalogue({ cwd, scope: "both", builtin: true }));
if (!flow.ok) throw new Error(flow.faults.map((fault) => fault.message).join("\n"));
const run = await checkRun(flow.flow, { cwd, ports: { check: bashCheck(), git: gitPort() }, somebodyThere: false });
if (!run.ok) throw new Error(run.faults.map((fault) => fault.message).join("\n"));
const measured = measuredRun({ dir: runDir });
const result = await runFlow(run.run, "add a cache in front of the loader", { model, runDir, onEvent: measured.onEvent });
measured.finish();
```

This is what `/run build` does, with the terminal's card as the `ask` port.
The `deliver`, `pair` and `audit` combinators the linear pipeline ran are gone
with it: this flow is the one implementation of that shape, and the only one
with a journal, restored copies and a script as its check.

## Reference

- [`build`](../reference/flows/build.md) and [`build-attended`](../reference/flows/build-attended.md) - the shipped flows, drawn.
- [Flows](flows.md) - the format, the run directory, resuming.
- [Extension](extension.md#running-a-flow) - `/run` and `/run resume`.
