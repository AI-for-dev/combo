---
myst:
  html_meta:
    "description": "Working copies, so two subagents can write at once without writing over each other."
---

# Worktrees

Two subagents writing to one directory is why the shipped `build` flow runs its
subtasks with `concurrency: 2` and `copies: true`: past one writer, "independent
subtasks" stops being a promise a planner can keep. A working copy each turns
that into a question about the tasks rather than about the filesystem.

`src/git/worktree.ts` is the git side of it. It does four things and no more.

```typescript
import { createWorktree, listWorktrees, removeWorktree, worktreePatch } from "@ai-for-dev/combo";

const made = await createWorktree(repo, { path: "/tmp/one", branch: "combo/one", base: "main" });
const patch = await worktreePatch("/tmp/one", "main");
await removeWorktree(repo, "/tmp/one", { patched: patch.ok });
```

Every call gives back a `GitResult<T>`: a value, or git's own words about why
not. That is the same contract `src/git/git.ts` uses, for the same reason a
workflow turns a model failure into `ok: false`. A copy that could not be made
is an outcome the caller decides about.

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

## The three calls that only ever happen together

Making a copy, taking its patch and removing it are never done apart, and the
order they go in is the whole safety of the thing. `scratchWorktree` is that
order, written once: a copy made for one piece of work, and released when the
work is done.

```typescript
import { scratchWorktree } from "@ai-for-dev/combo";

const made = await scratchWorktree(repo, "add a slugify helper");
if (!made.ok) return;                     // no copy, no work - the caller decides

const scratch = made.value;
scratch.path;                             // what a subagent gets as its cwd
scratch.branch;                           // named after the work, so `git branch` reads
const patch = await scratch.release();    // the work out, the copy gone
```

It lives under the system's temporary directory, outside the repository: a copy
made inside the tree its own patch is taken against would show up in that
patch. The base is a commit rather than a branch name, so the patch is against
what the work really started from even if the branch has moved since.

`release()` is idempotent and safe in a `finally`. A second call gives back the
patch the first one took rather than an empty one, so releasing explicitly and
again in a `finally` cannot lose it. It commits the work on the branch before
the copy goes, deletes a branch nobody wrote on, and on a patch it could not
take leaves everything where it is: the caller gets the error and the work
stays on disk.

## A copy per branch, not per subagent

In a flow, `copies: true` on a `map` or a `parallel` gives each branch one copy,
and every node of the branch works in it. In `build` that is the coder and the
reviewer of one subtask: a reviewer with a copy of its own would be reading the
code the coder did not touch, which is a review of nothing. [Flows](flows.md#branches-that-run-together)
says when a block needs copies, what lands, and what a stopped run keeps.

The copy is released whatever ended the branch, cancellation and failure
included: whoever opens closes. The work is committed on the copy's branch
before the copy goes, so a caller that drops the patch has still lost nothing,
and a branch nobody wrote on is deleted: a name for no work would only pile up,
one per run.

## Putting them back together

`land` applies the patches to one tree, one at a time.

```typescript
const landed = await land(repo, [
	{ label: "subtask 1", patch: first },
	{ label: "subtask 2", patch: second },
]);

landed.applied;   // what went in, in the order it did
landed.rejected;  // the one that stopped it, when one did
```

One at a time because a conflict after three patches says only that one of
them caused it. A patch is checked before it is applied, so one that does not
fit touches nothing, and it stops the rest. A flow's `check` written after the
block then judges the tree as a whole.

**Nothing is rolled back.** A failure stops the rest where it is, and what
landed stays landed: undoing would discard work, and every patch is also on its
branch.

The tree has to be clean to start with, or "which patch broke this" stops
having an answer. `requireCleanTree: false` is for the caller that put those
changes there itself and is therefore the only one able to tell them from
somebody else's: a flow run lands each block onto what earlier blocks landed.

Landing adds no commit and moves no ref. What goes in stays in the working tree
for a human to read.

`examples/13-concurrent-writers.ts` runs two coders at once on two subtasks, a
`scratchWorktree` each, prints the two patches, then lands them.

## What has no function here

No `push`, no `merge`, no `rebase`, nothing that rewrites history. The rule is
`src/git/git.ts`'s own: adding one of those is a decision somebody takes in a
diff, not
an argument a model produces at runtime. See
[Design decisions](../decisions.md).
