# From pipelines to flows

A linear pipeline is refused with `pipeline-format-removed`, and there is no
converter: rewriting one takes a few minutes, and the flow it becomes says what
the pipeline only implied. This page rewrites the three pipelines the package
shipped, `explore`, `split` and `build`, each beside the flow that replaced it.
[Flows](flows.md) has the whole format.

## What moves where

The file keeps its shape: YAML frontmatter for the structure, one `## <id>`
section per turn for the prose. What changes is what a node is.

| Pipeline | Flow |
| --- | --- |
| `pipelines/`, `~/.pi/agent/pipelines/`, `.pi/pipelines/` | `flows/`, `~/.pi/agent/flows/`, `.pi/flows/`, the same precedence |
| `steps:` | `nodes:`, and an `input:` saying what the flow is started on, `string` for a request |
| a step naming a combinator, which spawns agents inside it | one `agent` node per turn, inside the blocks that repeat or fork it |
| a `## <id>` section per step | a `## <id>` section per `agent` node, and none for a block |
| the request and the step before, handed to every step | `reads:`, the addresses a node is handed, each under its own heading |
| `fanOut` with `tasks:` | a `map` over a literal list, its item read as `item` |
| `orchestrate` with `workers:` | an `agent` node with a typed `output:`, then a `map-from` whose node picks its agent with `agent-from:` and `among:` |
| `reduce` | an `agent` node that reads the block before it |
| `loop` with `until:` a word | a `loop` whose `until:` is a condition, the decision a `verdict:` node gives |
| `deliver`, `pair`, `audit` | the loops, `map` and `check` they held, written out, as in `build` below |
| `verify:` or `--check` | a `check` node naming a script of the project |
| `lifetime: workflow` | `memory:`, the scope two nodes share a subagent in |
| `maxTasks:`, `maxIterations:`, `maxRounds:` | `max:` on the `map` or the `loop` |

A prompt that asked a model for a word (`APPROVED`, `LGTM`) asks for a tool call
now: a node with `verdict:` approves or raises obligations, and a condition
reads the verdict. Delete the sentence that named the word.

Once the file is in `flows/`, `/flows` lists it with its bound, or with its
faults, and `/flows <name>` prints its plan. Delete the old file: while it
stays, `/flows` keeps listing it as refused.

## `explore`: a fan-out, then a synthesis

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
  - id: answer
    reduce: synthesiser
---

## look
Read only. Report what you found with file paths and line numbers.

## answer
Answer the question from the three reports below.
```

The `fanOut` becomes a `map` over the same three tasks, whose one node is the
scout's turn; that node gets the section. The synthesiser reads the request and
the `map`, which hands on each item's report. `on-fail: continue` on the scout
turns a failed branch into a failed report, as the fan-out did, rather than a
failed run.

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
found with file paths and line numbers.

## answer
Answer the question under `input` from the three reports under `look`.
```

The prose names the heading each read arrives under: a turn holding three reads
has three sections, and "the reports below" points at none of them.

## `split`: a planner, then a worker per task

```markdown
---
name: split
description: A planner splits a read-only question between a scout and a reviewer, then one agent answers
steps:
  - id: work
    orchestrate: planner
    workers: [scout, reviewer]
    maxTasks: 4
    concurrency: 2
  - id: answer
    reduce: synthesiser
---

## work
Split the request below. Everything here is read-only.

## answer
Answer the request from the reports below.
```

`orchestrate` hid two turns and a parser: the planner wrote a plan, our code
read it, then a worker ran per task. The flow writes both turns. The planner's
`output:` is a schema, so its plan arrives through a tool call and is checked
against the schema; the worker's name is an enum of the two agents, and
`among:` says which file each value runs. `max: 4` is `maxTasks`: a plan of
more tasks fails the run before any worker starts.

```markdown
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
and says what is wrong with it. Everything here is read-only.

## act
Do the task under `item.task`.

## answer
Answer the request under `input` from the reports under `work`.
```

`orchestrate` handed the planner each worker's description; a flow hands a turn
its `reads:` and nothing else, so the planner's section says what each worker
does.

## `build`: a delivery, written out

```markdown
---
name: build
description: Locate the code, split the work, implement it in pairs, audit the whole
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
Find the code the brief below touches.

## work
Deliver the brief below, using the scout's report as the map of where things
live. The reviewer approves with APPROVED and nothing else.
```

One `deliver` step held a planner, a pair per subtask, a check and an audit,
none of it in the file. The flow writes each one as a node, which is what lets
`/flows build` print its bound (112 turns at most) and a dry run walk it:

- `plan` is the planner's turn, its subtasks typed.
- `deliver` is the audit round, `maxAuditRounds: 2` becoming `max: 2`. Its
  `carry:` hands the first round the plan and the second what the audit raised
  and nobody closed, from the round's ledger.
- `work` is a `map` over those subtasks, `maxTasks: 6` becoming `max: 6`, each
  in its own copy of the repository (`copies: true`).
- `pair` is the coder and the reviewer, `maxRounds: 3` becoming `max: 3`. They
  share a subagent each for the whole pair (`memory: pair`), and the reviewer
  decides through `verdict: pair` rather than a word.
- `tests` is the check, a script of the project in place of `verify:`.
- `audit` decides the round through `verdict: deliver`. It and the review are
  asked once more (`retry: 1`) when a turn ends without the call.

```markdown
---
name: build
description: Locate the code, split the work, implement it in pairs, check and audit the whole
input: string

nodes:
  - id: locate
    agent: scout
    reads: [input]

  - id: plan
    agent: planner
    reads: [input, locate]
    output: { subtasks: [{ text: string }] }

  - id: deliver
    loop: tests.output.passed && audit.output.approved
    max: 2
    ledger: deliver
    carry: { first: plan.output.subtasks, next: deliver.ledger }
    give-up: size(deliver.ledger) == 0
    do:
      - id: work
        map-from: deliver.carry
        max: 6
        concurrency: 2
        copies: true
        do:
          - id: pair
            loop: review.output.approved
            max: 3
            ledger: pair
            on-fail: continue
            do:
              - id: code
                agent: coder
                memory: pair
                retry: 1
                reads: [item.text, pair.previous.review, pair.ledger]

              - id: review
                agent: reviewer
                memory: pair
                verdict: pair
                retry: 1
                reads: [item.text, code, diff]

      - id: tests
        check: .pi/checks/test.sh
        timeout: 10m

      - id: audit
        agent: auditor
        verdict: deliver
        retry: 1
        reads: [input, work, tests, diff, deliver.ledger]
---
```

The five sections, `locate`, `plan`, `code`, `review` and `audit`, are in the
shipped [`flows/build.md`](../reference/flows/build.md). The check is the part
each project writes: `.pi/checks/test.sh` runs the project's own tests, and a
build launched where it is missing is refused before its first turn with
`check-script-missing`.
