---
name: split
description: A planner splits a read-only question between a scout and a reviewer, then one agent answers
steps:
  - id: work
    orchestrate: planner
    workers:
      - scout
      - reviewer
    maxTasks: 4
    concurrency: 2
    lifetime: task

  - id: answer
    reduce: synthesiser
    lifetime: task
---

## work

Split the request below. Everything here is read-only: nothing is to be
modified, only found, read and judged.

## answer

Answer the request from the reports below. Where two of them disagree, say so
rather than picking one; where none of them covers a part of the request, say
that too.
