---
myst:
  html_meta:
    "description": "Working copies, so two subagents can write at once without writing over each other."
---

# Worktrees

Two subagents writing to one directory is the constraint behind `deliver`'s
`concurrency` default of **2**, not 4: past that, "independent subtasks" stops
being a promise a planner can keep. A working copy each turns that into a
question about the tasks rather than about the filesystem.

`src/worktree.ts` is the git side of it. It does four things and no more.

```typescript
import { createWorktree, listWorktrees, removeWorktree, worktreePatch } from "combo";

const made = await createWorktree(repo, { path: "/tmp/one", branch: "combo/one", base: "main" });
const patch = await worktreePatch("/tmp/one", "main");
await removeWorktree(repo, "/tmp/one", { patched: patch.ok });
```

Every call gives back a `GitResult<T>`: a value, or git's own words about why
not. That is the same contract `git.ts` uses, for the same reason a workflow
turns a model failure into `ok: false`. A copy that could not be made is an
outcome the caller decides about.

## A copy nobody captured is not removed

`removeWorktree` refuses a copy that still holds changes when `patched` is
false, and names the path so whoever reads the run can go and look.

Losing what a child wrote to make room is the one failure here a rerun cannot
undo. Everything else in this library fails into a `Result` and another attempt;
this does not, so it is the one place that stops rather than carries on.

`patched: true` is the caller saying the work is somewhere else now. It is also
what lets git's own refusal be passed, since git knows nothing about the patch
you are holding. A caller who wants a copy gone whatever it holds deletes the
directory itself: that is not an act this module performs on anyone's behalf.

## What the patch contains

`worktreePatch` runs `git add --intent-to-add` before it diffs, because a file
the child created is the ordinary case for a coder and `git diff` alone does not
show one. That writes to the index of the copy, which is acceptable: the copy
exists to be read and then dropped, and a patch missing every new file would be
worse than a touched index.

The patch is capped, like every other text that ends up in a prompt, and says so
where it was cut.

## A copy per piece of work, not per subagent

`pair` takes `worktree: true` and gives both its agents one copy, made from
`cwd`. The result carries the branch it landed on and the patch of what changed.

```typescript
const built = await pair({ worker: coder, reviewer, input: task, cwd: repo, worktree: true });
built.worktree;   // combo/add-a-slugify-helper-a1b2c3, with the work committed on it
built.patch;      // the same work as a diff against what it started from
```

The copy is made from the **commit** `cwd` is on, not from its working tree:
changes you have not committed are not there, and the patch is a diff against
that commit. Commit before pointing a pair at a tree you are in the middle of.

The work is committed on that branch before the copy goes, so a caller that
drops the patch has still lost nothing. A pair that wrote nothing gets no branch
and no patch: a name for no work would only pile up, one per run.

A copy that cannot be released keeps the work. A commit a hook refuses, or a
removal git will not do, leaves the copy on disk and the pair comes back
`ok: false` with that path in its `error`. Otherwise an approved pair that lost
its patch would read exactly like one that wrote nothing.

Both agents share it deliberately. A reviewer with a copy of its own would be
reading the code the worker did not touch, which is a review of nothing.

The copy is released in a `finally`, cancellation and failure included: whoever
opens closes. A copy that could not be made **stops the pair** rather than
quietly writing into the tree the caller asked to spare.

## Putting them back together

`land` applies the patches to one tree, one at a time, and runs the project's
own check between them when it is given one.

```typescript
const landed = await land(repo, [
	{ label: "subtask 1", patch: first.patch ?? "" },
	{ label: "subtask 2", patch: second.patch ?? "" },
], { verify });

landed.applied;   // what went in, in the order it did
landed.rejected;  // the one that stopped it, when one did
```

One at a time because a red tree after three patches says only that one of them
broke it. A patch is checked before it is applied, so one that does not fit
touches nothing.

**Nothing is rolled back.** A failure stops the rest where it is, and what
landed stays landed: undoing would discard work, and every patch is also on its
branch.

The tree has to be clean to start with, or "which patch broke this" stops
having an answer. `requireCleanTree: false` is for the caller that put those
changes there itself and is therefore the only one able to tell them from
somebody else's.

Landing adds no commit and moves no ref. What goes in stays in the working tree
for a human to read.

`deliver` does all of this for a whole delivery, by default from two subtasks
up: a copy per subtask, then a landing per batch of them. `landable()` is the
question it asks first - whether this tree can take the patches back at all -
because a copy whose patch cannot come home is a subtask paid for twice. See
[Deliver a change](build.md).

`examples/13-concurrent-writers.ts` runs two pairs at once on two subtasks and
prints the two patches, leaving the repository it was pointed at untouched.

## What has no function here

No `push`, no `merge`, no `rebase`, nothing that rewrites history. The rule is
`git.ts`'s own: adding one of those is a decision somebody takes in a diff, not
an argument a model produces at runtime. See
[Design decisions](../decisions.md).
