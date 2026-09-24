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

  - id: report
    agent: synthesiser
    reads: [input, diff, deliver.output.last.work, deliver.output.last.audit]
---

## locate
Find the code the brief under `input` touches.

Report file:line for each place, and nothing else: no plan, no opinion on what
should change. What you miss here, the planner will not know exists.

## plan
Split the brief under `input` into subtasks, using the scout's report under
`locate` as the map of where things live.

Every subtask must be independently applicable to the working tree: when the
work is sequential, it is one subtask, not three. A coder sees its subtask's
text and nothing else, so name the files and say what done looks like.

## code
Do the task under `item.text`.

When `pair.previous.review` follows, the reviewer did not approve your last
change: address each remark in it and each obligation under `pair.ledger`, or
say plainly why you did not.

## review
Review the change made for the task under `item.text`. The coder's summary is
under `code` and the change itself under `diff`: the summary is a claim, the
diff and the code are the evidence. Approve the change, or raise what still has
to change.

## audit
Audit the whole change under `diff` against the brief under `input`.

`work` says how each subtask's review ended: one that did not converge is not
done until the code shows it is. `tests` says whether the project's own tests
pass; while they fail, the work is not finished, so raise what makes them fail.
`deliver.ledger` holds what an earlier audit raised and nobody has closed yet.

Approve the whole, or raise each fix line on its own: each one comes back to
you by its id, and the work is not finished while one of them is open.

## report
Tell the person who asked for the work under `input` what they now have. The
change is under `diff`, and it is the evidence. How each subtask of the last
round ended is under `deliver.output.last.work`, and the audit of the whole
under `deliver.output.last.audit`: the tests pass and the audit approved, or
this turn would not run.

Write a few lines of plain prose for someone about to read the diff, no
headings and no JSON: what was done, and in which files; then what is left, a
subtask whose review did not converge or whose patch did not land and each
remark the audit left, or say that nothing is.
