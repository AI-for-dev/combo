# Three scouts, one answer

![Three scouts, one answer](../_static/tutorials/02-three-scouts.svg)

```{note}
This page was captured when `explore` was a linear pipeline,
`pipelines/explore.md`. It is a flow now, [`flows/explore.md`](../reference/flows/explore.md),
and [From pipelines to flows](../guide/from-pipelines.md) sets the two side by
side. The file and the frames below predate that change.
```

A question that spans a repository has three parts hiding in it: where the
thing is implemented, how it is tested, and what the documentation claims. One
agent answering all three reads everything, and a small one gets the first part
right and drifts on the other two. Three agents answering one part each read a
third as much, at the same time, and somebody still has to put the parts
together without inventing the joints.

That shape comes up often enough to ship as a file. Look at it before you run
it:

```bash
cat pipelines/explore.md
```

```markdown
---
name: explore
description: Three scouts read the code in parallel, then one agent answers from what they found
steps:
  - id: look
    fanOut: scout
    tasks:
      - Find where the thing asked about is implemented, and name the files.
      - Find how it is tested, and what the tests actually assert.
      - Find what documents it, and whether that matches the code.
    concurrency: 3
    lifetime: task

  - id: answer
    reduce: synthesiser
    lifetime: task
---

## look

Read only. Report what you found with file paths and line numbers, and say
plainly when you found nothing - an empty branch is worth more than a guess.

## answer

Answer the question from the three reports below. Where they disagree, say so
rather than picking one; where they are all silent, say that too.
```

Two steps. A fan-out of three scouts with **literal** tasks, then a reduce by a
synthesiser that receives the three reports. Nothing in the file decides
anything at run time: our code walks it, and the only thing a model chooses is
what to write.

## Run it

```
/run explore how is the wall time of a subagent measured, and where
```

The three dots appear at once:

```
● scout#3  thinking…
● scout#2  grep /wall time|subagent.*time|duration|elapsed/
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

Two, in this frame, because `scout#1` was already done. Watch the middle one:
it greps, then reads `src/subagent.ts`, then `test/export.test.ts`, then
`test/fan-out.test.ts`. That is the branch that was asked about tests, and you
can see it doing exactly that and nothing else. When the last scout closes,
`synthesiser#1` appears alone, thinks for twenty seconds, and the answer lands
**in the conversation**:

```
Result of the explore pipeline, asked to: how is the wall time of a subagent
measured, and where.

The wall time of a subagent is measured as the elapsed time between when the
subagent is spawned and when its usage is either queried or the subagent is
closed. This is implemented using the monotonic clock provided by
performance.now().

The measurements occur in src/subagent.ts:
- At spawn: the start time is recorded: const spawnedAt = performance.now();
- During usage queries: the usage getter calculates the current wall time …
- At closure: the final wall time is captured when the subagent is closed …

The reports disagree on the specific line numbers in src/subagent.ts for these
operations:
- Spawn time: Report 1 says line 163, Report 2 says line 166, and Report 3
  says line 156.
- Usage getter: Report 1 says lines 195-198, Report 2 says lines 208-211, and
  Report 3 says lines 187-190.
- Closure: Report 1 says line 316, Report 2 says lines 283-284, and Report 3
  says line 264.

Additionally, Report 2 notes that wall time is measured for the entire
operation in aggregated workflows (e.g., src/workflows/fan-out.ts:48-67), and
Report 3 references docs/guide/measurements.md for documentation on wallMs
(defined as "spawn to close, waiting included").

explore: 2 steps, 4 turns - exported to /…/combo/runs/2026-09-19_10-28-18
```

That is the frame, verbatim except for the path.

## Read the disagreement

The three scouts read the same file and reported three different line numbers
for the same statement. The synthesiser was told to say so rather than pick one,
and it did. Settle it yourself:

```bash
grep -n spawnedAt src/subagent.ts
```

```
195:	const spawnedAt = performance.now();
251:			return { ...usage, wallMs: performance.now() - spawnedAt };
353:			const finalUsage = { ...usage, wallMs: performance.now() - spawnedAt };
```

All nine numbers were wrong. The content was right three times over: the
mechanism, the clock, the three places. The line numbers were a small model's
guess written as a citation. Had one scout answered alone you would have had
one confident wrong number and no way of knowing. Three that disagree tell you
something; an answer that averaged them, or took the first, would have hidden
it.

The synthesiser works by one rule, and so should anything that folds several
agents' work into one: a report is a claim, not evidence. A branch that fails
comes through the same way, marked as failed in its slot, so the answer can
say "not covered" instead of answering from two reports as if there had been
three.

## What it cost, and where that is written

Open the folder the last line named:

```
runs/2026-09-19_10-28-18/
├── scout-1.html    scout-1.jsonl
├── scout-2.html    scout-2.jsonl
├── scout-3.html    scout-3.jsonl
├── synthesiser-1.html    synthesiser-1.jsonl
└── usage.json
```

One transcript per subagent, rendered by pi itself, and one file we write:

| subagent | wall | input | output | what it did |
| --- | --- | --- | --- | --- |
| scout#1 | 12.0s | 21.9k | 853 | three tool calls, the implementation |
| scout#2 | 41.2s | 61.1k | 1.9k | five tool calls, the tests |
| scout#3 | 23.3s | 38.4k | 1.1k | six tool calls, the docs |
| synthesiser#1 | 22.2s | 2.2k | 1.2k | no tool call, the answer |
| **run** | **63.5s** | **123.6k** | **5.1k** | parallelism 1.56 |

`parallelism` is busy time over wall time: 98.8 seconds of work happened in
63.5. Three scouts did not give three times the speed, because the slowest
branch sets the pace and the synthesiser waits for all of them. That number is
in `usage.json` because it answers "was the fan-out worth it", and nothing in
the widget could have told you.

`cost` reads `0` in every row. That provider reports no cost, and combo does
not estimate one from characters: a zero here means "not reported", never
"free". [Measurements](../guide/measurements.md) says what is counted and what
is refused.

## The answer is in your context now

Look at the status line: `0.0%` before, `0.3%` after. The answer arrived as a
message the model can read, prefixed with what produced it, so the next thing
you type can lean on it:

```
> and is busyMs measured the same way?
```

The model answers from the report. That is `/run`'s whole reason to put the
answer there: an exploration you have to paste back into the conversation
yourself is a report in the wrong place.

Sometimes it is what you did not want. A main model that has read a report
starts acting on it: it becomes the orchestrator, and every step you ask for
next is chosen against a conclusion it already holds. When the window is meant
to stay a console, what reaches it changes the answers.

**Next:** [Keep the session out of it](03-keep-the-session-out.md).
