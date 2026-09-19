# A subagent that splits its own task

Everything so far had you, or a file, decide how the work was split. There is
a third case: an agent that looks at its task, decides it is too big, and
spawns help. Whether it can is not the question. How far down that goes, who
is allowed to do it, and what the bill looks like afterwards are.

## Who may delegate

Nothing in a call turns delegation on. The **agent's own definition** does:

```bash
cat agents/explorer.md
```

```markdown
---
name: explorer
description: Answers a question about a large codebase by splitting the reading across scouts
tools: read, grep, find, ls, subagent
lifetime: task
concurrency: 3
---

You answer one question about a codebase you have not read.

The repository is too large to read yourself, so you split the reading. …
Two to four tasks. Fewer than two and you may as well read it yourself; more
than four and you are guessing at where the answer is rather than thinking.
```

`subagent` in `tools:` is combo's, not pi's, and an agent that names it is
handed one. Anybody else is offered nothing. The roster it may reach is the
one your call loaded, so `scope` covers the grandchildren too; a name that is
not on it is refused, never guessed. `concurrency: 3` is how many children it
runs at once, and it belongs in the file because it follows from how the agent
was told to think: two to four tasks, three in flight.

## Run it, and keep the record

```
> use subagent with agent "explorer" and export true to compare the four reporters
```

The dots draw the tree as it grows:

```
● explorer#1  subagent agent=scout tasks=["Analyze `src/reporters/cons…
  ● scout#1  thinking…
  ● scout#2  thinking…
  ● scout#3  read src/reporters/record.ts
```

The explorer listed the directory, wrote four tasks, and handed them over.
The children sit under the one that asked for them, indented, and the tool row
keeps that shape when it is over:

```
subagent single explorer
  Compare the reporters available in `src/reporters/`. I believe there …
✓ explorer#1 Compare the reporters available in `src/reporters…
    ls src/reporters/
    subagent agent=scout tasks=["Analyze `src/reporters/cons…
  ✓ scout#1 Analyze `src/reporters/console.ts` and `src/repor…
      read src/reporters/console.ts
      read src/reporters/silent.ts
  ✓ scout#2 Analyze `src/reporters/tui.ts`. Describe its purp…
      read src/reporters/tui.ts
  ✓ scout#3 Analyze `src/reporters/record.ts`. Describe its p…
      read src/reporters/record.ts
  ✓ scout#4 Analyze `src/reporters/herdr.ts` and `src/reporte…
      read src/reporters/herdr.ts
      read src/reporters/herdr-client.ts
```

Read the four tasks. Each scout sees only the line the explorer wrote it, and
each line names the file to start from. That is the explorer's prompt doing
its job, and the first thing to check when a delegating agent comes back with
nonsense is whether the children were asked badly.

## The bill is a tree

`export true` wrote every transcript and one `usage.json` into
`runs/<timestamp>/`, and the report carries the tree:

| subagent | parent | wall | input | output | calls |
| --- | --- | --- | --- | --- | --- |
| explorer#1 | | 48.2s | 6.9k | 1.9k | 2 |
| scout#1 | explorer#1 | 16.5s | 2.8k | 969 | 1 |
| scout#2 | explorer#1 | 12.6s | 5.6k | 1.4k | 2 |
| scout#3 | explorer#1 | 5.9s | 2.8k | 636 | 2 |
| scout#4 | explorer#1 | 12.4s | 6.8k | 1.1k | 1 |
| **run** | | **48.3s** | **25.0k** | **6.0k** | parallelism 1.98 |

Two rules are visible in it. **The total is the tree, never the root.** The
explorer's own turn cost 6.9k input tokens; the run cost 25k, and a report
that summed the roots would call this a cheap agent when it is a cheap agent
and an expensive run. **The link is an id, never a name.** Two explorers
running at once share a name; `parentId` is the id `spawn` minted for whoever
asked, and a child whose parent is not in the list reads as a root rather
than vanishing from the sum.

Compare it to [three scouts on one question](02-three-scouts.md): 25k input
here against 124k there, for the same model. The explorer wrote narrower
tasks than the pipeline's three fixed ones, and each scout read one or two
files instead of hunting. Whether that holds on your question is what the
export is for.

## How deep it goes

Two levels by default: your session, a child, a grandchild. Pass `maxDepth`
on the call to change it. At the bound, the tool is **still handed over and
refuses when called**, saying how deep it is and how deep it may go:

```
You are 2 level(s) deep and 2 is the limit. Do this part of the work yourself.
```

Withholding it instead would leave a model calling a tool that is not there,
getting "unknown tool", and trying again. That is the runaway turn
[the meter](10-the-meter.md) exists to catch, and a refusal in words is what a
model can act on.

The children run on the terms of the call: its model, its deadline, its export
directory, its signal. `esc` stops the whole tree, `ctrl+↑↓` walks it children
included, and a delegated child is disposable whatever the parent's lifetime.

## Where the line is

An agent can split its task. It cannot write a pipeline, and it will not be
given a way to: what a generated pipeline would buy is a reviewable artefact,
and `orchestrate` already gives that with a parser and a cap. A second, larger
place where a model decides the shape of a run is more surface for the same
benefit. You write the file; the file is data; the run is ours.

That is the last of the twelve. What they had in common was not a feature:
every claim an agent made had a record behind it you could open, and every
act it performed went through a boundary you could read in a file.
[Design decisions](../decisions.md) has the reasons, and the reversals.
