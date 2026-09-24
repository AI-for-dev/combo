# Three scouts, one answer

![Three scouts, one answer](../_static/tutorials/02-three-scouts.svg)

A question that spans a repository has three parts hiding in it: where the
thing is implemented, how it is tested, and what the documentation claims. One
agent answering all three reads everything, and a small one gets the first part
right and drifts on the other two. Three agents answering one part each read a
third as much, at the same time, and somebody still has to put the parts
together without inventing the joints.

That shape comes up often enough to ship as a file. Look at it before you run
it:

```bash
cat flows/explore.md
```

```markdown
---
name: explore
description: Three scouts read the code in parallel, then one agent answers from what they found
input: string

nodes:
  - id: look
    map:
      - Find where the thing asked about is implemented, and name the files.
      - Find how it is tested, and what the tests actually assert.
      - Find what documents it, and whether that matches the code.
    concurrency: 3
    do:
      - id: find
        agent: scout
        reads: [input, item]
        on-fail: continue

  - id: answer
    agent: synthesiser
    reads: [input, look]
---

## find
Do the task under `item` about the question under `input`. Report what you
found with file paths and line numbers, and say plainly when you found nothing:
an empty report is worth more than a guess.

## answer
Answer the question under `input` from the three reports under `look`. Where
they disagree, say so rather than picking one; where they are all silent, say
that too.
```

Two nodes. A `map` over three **literal** tasks, whose one node is a scout's
turn, then a synthesiser that reads the question and the three reports. Each
turn is handed exactly what its `reads:` names, each under its own heading.
Nothing in the file decides anything at run time: our code walks it, and the
only thing a model chooses is what to write.

## Run it

```
/run explore how is the wall time of a subagent measured, and where
```

The flow's plan appears above the prompt at once, and fills as it goes:

```
● explore · 1 visit · 20s · ↑17k ↓1.1k
● look · 1/3
  ● look[1]
    ● look[1]/find
      ● scout#1  read src/subagent.ts  provider/model · 19.2s
  ● look[2]
    ● look[2]/find
      ● scout#2  read test/trail.test.ts  provider/model · 19.2s
  ✓ look[3] · 15s · ↑17k ↓1.1k
○ answer · agent synthesiser (.pi/agents/synthesiser.md) · reads input, look · timeout 30m by default · ≤ 1 turn · ≤ …
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

`look[3]` has finished and folded to one line, with its tokens. The two scouts
still working show a clock and no tokens: pi reports a turn's tokens when the
turn ends, and until then there is no figure to show. The first line counts
the run's time as it goes and adds up what has ended. Watch `scout#2`: it
greps, reads `src/subagent.ts`, then `test/measured.test.ts`,
`test/trail.test.ts` and `test/export.test.ts`. That is the branch that was
asked about tests, and you can see it doing that and nothing else. When the
last scout closes, the synthesiser runs alone for 71 seconds, and the answer
lands **in the conversation**:

```
◆ explore
Result of the explore flow, asked to: how is the wall time of a subagent measured, and where.

The wall time of a subagent is measured as the elapsed time from when it is spawned until it is either closed or
accessed via its usage getter. This is implemented in src/subagent.ts using performance.now().

The process is as follows:
- Spawn: A timestamp is captured using performance.now() when the subagent is created.
- Current Wall Time: The usage getter calculates the elapsed time by subtracting the spawn timestamp from the current
  performance.now().
- Final Wall Time: The duration is calculated one final time when the subagent is closed.

The reports disagree on the exact line numbers in src/subagent.ts where these are implemented (citing various lines
around 161–176 for spawning, 203–227 for the getter, and 304–387 for closing). This is documented in
docs/tutorials/03-keep-the-session-out.md.

ok · runs/2026-09-24_00-47-07

✓ explore · 5 visits · 1m44s · ↑102k ↓4.5k
✓ look · 3 items · 33s · ↑100k ↓3.7k
✓ answer · synthesiser · 1m11s · ↑2.2k ↓759
```

That is the frame, verbatim. The line under the answer says how the run
ended and where it is on disk, and the last three lines are the plan as it
finished, drawn for you and not sent to the model.

## Read the disagreement

The three scouts each read `src/subagent.ts` and reported three different
line numbers for each of the same three statements: 169, 161 and 176 for the
spawn, 214, 203 and 224-227 for the getter, 307, 304 and 387 for the close.
The synthesiser was told to say so rather than pick one, and it did, as
ranges. Settle it yourself:

```bash
grep -n spawnedAt src/subagent.ts
```

```
217:	const spawnedAt = performance.now();
283:			return { ...usage, wallMs: performance.now() - spawnedAt };
387:			const finalUsage = { ...usage, wallMs: performance.now() - spawnedAt };
```

One number in nine was right, and the next section says where it came from.
The content was right three times over: the mechanism, the clock, the three
places. The line numbers were a small model's guess written as a citation. Had one scout
answered alone you would have had one confident wrong number and no way of
knowing. Three that disagree tell you something; an answer that averaged them,
or took the first, would have hidden it.

The synthesiser works by one rule, and so should anything that folds several
agents' work into one: a report is a claim, not evidence. A branch that fails
comes through the same way: `on-fail: continue` turns a failed scout into a
failed report in its slot, so the answer can say "not covered" instead of
answering from two reports as if there had been three.

## What it cost, and where that is written

Open the folder the answer named. It is the run directory:

```bash
find runs/2026-09-24_00-47-07 -type f -not -path '*/.sessions/*' | sort
```

```
runs/2026-09-24_00-47-07/answer/synthesiser.html
runs/2026-09-24_00-47-07/answer/synthesiser.jsonl
runs/2026-09-24_00-47-07/journal.jsonl
runs/2026-09-24_00-47-07/look[1]/find/scout.html
runs/2026-09-24_00-47-07/look[1]/find/scout.jsonl
runs/2026-09-24_00-47-07/look[2]/find/scout.html
runs/2026-09-24_00-47-07/look[2]/find/scout.jsonl
runs/2026-09-24_00-47-07/look[3]/find/scout.html
runs/2026-09-24_00-47-07/look[3]/find/scout.jsonl
runs/2026-09-24_00-47-07/main.jsonl
runs/2026-09-24_00-47-07/snapshot.json
runs/2026-09-24_00-47-07/usage.json
```

One transcript per turn, under the visit that ran it and rendered by pi
itself. `snapshot.json` is the flow as it was checked, `journal.jsonl` every
visit as it ended, which is what a resume reads; `main.jsonl` is your own
session. `.sessions/`, left out above, is where pi kept the sessions those
transcripts were exported from. And `usage.json`:

| subagent | wall | input | output | what it did |
| --- | --- | --- | --- | --- |
| scout#1 | 22.8s | 13.4k | 505 | two tool calls, the implementation |
| scout#2 | 33.0s | 69.5k | 2.1k | six tool calls, the tests |
| scout#3 | 14.5s | 16.7k | 1.1k | two tool calls, the docs |
| synthesiser#1 | 70.8s | 2.2k | 759 | no tool call, the answer |
| **run** | **103.8s** | **101.7k** | **4.5k** | parallelism 1.36 |

`parallelism` is busy time over wall time: 141 seconds of work happened in
104. Three scouts did not give three times the speed, because the slowest
branch sets the pace and the synthesiser waits for all of them. Here the
synthesiser alone took longer than the three scouts together. That number is
in `usage.json` because it answers "was the fan-out worth it", and nothing on
screen could have told you.

The quickest branch is worth a look. `scout#3` was asked what documents the
wall time. Its grep matched `docs/tutorials/03-keep-the-session-out.md`, the
next page of this tutorial, whose frame quotes an earlier scout's report with
line numbers in it. Then it read `src/subagent.ts` whole, reported that the
page "matches the code's logic perfectly", kept two of its numbers, and
"corrected" the third, `283`, the one the page had right, to `224-227`. Its
`387`, the one right number of the nine, came from a page and not from the
code. A document that quotes a model is one more claim, and a scout reading it
cannot tell.

`cost` reads `0` in every row. That provider reports no cost, and combo does
not estimate one from characters: a zero here means "not reported", never
"free", and the screen leaves it out rather than print a price of nothing.
[Measurements](../guide/measurements.md) says what is counted and what is
refused.

## The answer is in your context now

Look at the status line: `0.0%` before, `0.2%` after. The answer arrived as a
message the model can read, prefixed with what produced it, so the next thing
you type can lean on it:

```
> and is busyMs measured the same way?
```

> No, `busyMs` is measured differently.
>
> While **wall time** is a continuous measurement from the moment the subagent
> is spawned until it is accessed or closed, **busy time** is the sum of the
> durations of all active turns. …

That is `/run`'s reason to put the answer there: an exploration you have to
paste back into the conversation yourself is a report in the wrong place.

It is also what it costs. Before answering, the session took the report's
word for where to look and read `src/subagent.ts` itself, and the status line
went from `0.2%` to `17.0%`: pi's own system prompt and the context files,
paid on the session's first request, and one of the files the scouts read so
that you would not have to. A main model that has read a report starts acting
on it. It becomes the orchestrator, and every step you ask for next is chosen
against a conclusion it already holds. When the window is meant to stay a
console, what reaches it changes the answers.

**Next:** [Keep the session out of it](03-keep-the-session-out.md).
