# Two coders, one tree

![Two coders, one tree](../_static/tutorials/09-two-coders-one-tree.svg)

Two coders writing into one working tree can each be right and together be
wrong: one renames a function the other is calling, the check runs on a tree
neither of them wrote, and the failure belongs to nobody. That was the first
reason to keep writers apart, and it turned out to be the smaller of two
problems.

A probe measured the larger one. Four subagents were given one directory and
told only to write a file and list what they saw. Each of them read the other
three's files inside a single turn, without being asked to look. The same four
in four directories crossed nothing. A shared directory is not a hazard the
workers might hit. It is a channel, and they use it.

So a flow that runs writers at once gives each one a copy of the repository,
and it has to say so.

## Where the flow says it

The shipped `build` runs its subtasks in a `map`, two at a time:

```yaml
      - id: work
        map-from: deliver.carry
        max: 6
        concurrency: 2
        copies: true
        do:
          - id: pair
            ...
```

`copies: true` gives each item of the `map` one copy, and every node inside
the item works in it: the coder writes there and the reviewer reads there,
because a reviewer with a copy of its own would be reading code the coder never
touched.

Take the line out, in a `.pi/flows/build.md` that replaces the shipped one,
and the flow no longer checks:

```
Error: run: `build` is refused
  .pi/flows/build.md deliver/work.copies: `concurrency: 2` runs items at once, and `deliver/work/pair/code` writes
    (`coder` has edit, write): give each branch its own copy with `copies: true`, or `concurrency: 1`
```

The rule is read from the agents' files alone: branches that run together
need copies as soon as one of them has `write`, `edit`, `bash` or `subagent`.
Nothing was spawned to find that out, and `/flows` lists the same fault.

## Two subtasks

```
/run build add a slugify helper in slug.js and a titleCase helper in title.js, each with its own test file --model <provider/model>
```

The planner made two subtasks of that, and both pairs started at once:

```
● build · 2 visits · 1m59s · ↑164k ↓4.7k
… 2 lines above
● deliver · #1 of 2
  ● deliver#1
    ● deliver#1/work · 0/2 so far
      ● deliver#1/work[1]
        ● deliver#1/work[1]/pair · #1 of 3
          ● deliver#1/work[1]/pair#1
            ● deliver#1/work[1]/pair#1/code
              ● coder#1  write slug.js  provider/model · 21.8s
            ○ deliver#1/work[1]/pair#1/review · agent reviewer (.pi/agents/reviewer.md) · reads item.text, code, diff…
      ● deliver#1/work[2]
        ● deliver#1/work[2]/pair · #1 of 3
          ● deliver#1/work[2]/pair#1
            ● deliver#1/work[2]/pair#1/code
              ● coder#2  write title.js  provider/model · 21.5s
… 4 lines below
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

The plan takes sixteen rows at most, and the cuts say how many lines they
hold. Each coder is in its own copy, made under the system's temporary
directory, outside the repository, so a copy never shows up in the patch taken
against it. Each copy starts from a commit of the tree as it stood, uncommitted
changes included, and has a branch named after its item:

```
$ git log --oneline combo/deliver-1-work-2-auCq7P
fccaf65 combo: deliver#1/work[2]
e12b113 combo: the tree a copy starts from
20b4e33 init
```

A coder's id says when it was spawned, not which item it works on: the item's
place in the flow is the path, and that is what the landing goes by.

## Putting them back

When the `map` ends, the work is committed on each copy's branch, the copies
are removed, and each branch's patch lands in your tree, one at a time, in
item order, whatever order the pairs finished in. A patch is checked before it
is applied, so one that does not fit touches nothing and stops the ones after
it. Each item's entry in the block's output says `landed: true`, or `landed:
false` with git's reason on the one that stopped the landing.

Nothing is checked between patches. The check written after the block,
`deliver#1/tests`, judges the tree as a whole, and what the audit raises goes
to the next round like any other remark. Here both landed, the tests passed
and the audit approved:

```
✓ build · 13 visits · 3m40s · ↑226k ↓19k
✓ locate · scout · 1m23s · ↑160k ↓3.7k
✓ plan · planner · 15s · ↑4k ↓955
✓ deliver · 1 iteration · 1m55s · ↑59k ↓14k
✓ report · synthesiser · 9s · ↑3k ↓342
```

```
$ git status --short
?? slug.js
?? slug.test.js
?? title.js
?? title.test.js
```

The first item's reviewer answered `LGTM` in prose, without the `verdict`
call its node asks for, and a review that ends without the call fails with
`schema`. The node has `retry: 1`, so the flow sent the reviewer back once,
naming the failure, and its second answer was the call. Nothing failed: both
patches landed, the audit read both, and the check ran on the tree they made.

**Nothing is rolled back.** What landed stays landed when a later patch is
refused or the check fails, and a failed pair's patch lands like the others:
undoing would discard work, and every patch is also a commit on its branch. A
run that is stopped lands nothing, and each pair's work stays on its branch.
Those branches are yours: nothing deletes one that holds work, so they add up,
one per subtask per run, until you read them and delete them.

## What a copy does not close

A copy bounds writes. `..`, `/tmp` and everything else the `read` tool reaches
are outside any copy, and a subagent that goes looking still finds them.

That run shows it. Its scout, mapping the repository in the main tree before
any copy existed, made 36 tool calls and spent 160k of the run's 226k input
tokens. Four of those calls were on `runs/`: it listed the directory twice,
then the run it was itself part of, then that run's `.sessions/`, and every one
of them was sent again with each call after it. The record of a run is in the
tree it runs on, and to a model looking for where `slugify` lives, a run that
names it is a place. The copies closed the channel between the two
coders; this one was open to everyone.

## The one thing it will not do

A copy that still holds changes is never removed to make room. When its work
cannot be committed or its patch cannot be taken, the copy stays on disk with
everything in it, and the item's entry says `landed: false` with git's reason,
which stops the landing there. Everything else here fails into a `Result` and
a retry; losing what a child wrote is the one failure a rerun cannot undo, so
it is the one place that stops rather than carries on.

A resume takes the copies back: a pair whose copy is still there carries on in
it, as the resumed review of the previous page did, and one whose copy is gone
starts its subtask over in a fresh one.

## Now raise the number

`concurrency: 2` is the shipped file's, and a copy of it in `.pi/flows/build.md`
changes it. With copies the limit is no longer what one working tree can take
but what a run costs, and that is a fact about the bill, which is the file's to
say:

```yaml
      - id: work
        map-from: deliver.carry
        max: 6
        concurrency: 4
        copies: true
```

Four coders, and a bill with four times the turns in it. The next page is
about that bill: what it counts, what it refuses to guess, and how to end a
turn that has stopped earning its cost.

**Next:** [Watch the meter](10-the-meter.md).
