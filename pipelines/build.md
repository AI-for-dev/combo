---
name: build
description: Locate the code, split the work, implement it in pairs, audit the whole
steps:
  - id: locate
    chain: scout
    openInHerdr: true
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
Find the code the brief below touches.

Report file:line for each place, and nothing else - no plan, no opinion on what
should change. What you miss here, the planner will not know exists.

## work
Deliver the brief below, using the scout's report as the map of where things
live.

Every subtask must be independently applicable to the working tree: when the
work is sequential, it is one subtask, not three. The reviewer approves with
APPROVED and nothing else.
