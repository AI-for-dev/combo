---
name: split
description: A planner splits a read-only question between a scout and a reviewer, then one agent answers
input: string

nodes:
  - id: plan
    agent: planner
    reads: [input]
    output: { tasks: [{ worker: scout | reviewer, task: string }] }

  - id: work
    map-from: plan.output.tasks
    max: 4
    concurrency: 2
    do:
      - id: act
        agent-from: item.worker
        among: [scout, reviewer]
        reads: [item.task]
        on-fail: continue

  - id: answer
    agent: synthesiser
    reads: [input, work]
---

## plan
Split the request under `input` into one to four tasks, each for a `scout`,
who locates code and reports where it lives, or a `reviewer`, who reads code
and says what is wrong with it. Everything here is read-only: nothing is to be
modified, only found, read and judged.

## act
Do the task under `item.task`.

## answer
Answer the request under `input` from the reports under `work`. Where two of
them disagree, say so rather than picking one; where none of them covers a part
of the request, say that too.
