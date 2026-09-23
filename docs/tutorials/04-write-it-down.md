# Write the chain down

![Write the chain down](../_static/tutorials/04-write-it-down.svg)

```{note}
This page shows the linear pipeline, which flows replaced: a file in
`.pi/pipelines/` is refused now with `pipeline-format-removed`, and `/pipelines`
is `/flows`. [Flows](../guide/flows.md) is the format that replaced it, and
[From pipelines to flows](../guide/from-pipelines.md) rewrites a pipeline as a
flow. The files and frames below predate that change.
```

By the third time you have typed the same two steps, the workflow exists. It
lives in your shell history, where nobody can review it, nobody else can run
it, and a change to it is not a diff. Most agent tooling answers that with a
YAML file and a templating language. Within a year it has `if:` and
`${{ steps.x.outputs.y }}`, and it is a programming language with none of the
tools of one.

A combo pipeline is a Markdown file next to your agents, and it refuses to
become that. Steps are linear, with no condition and no reference back. The
moment a run needs a branch, it is TypeScript, and the file has done its job by
making that boundary visible.

## The problem worth a file

Documentation drifts from code. Every repository has a page that says a
default is 4 when the code says 2. The reading is always the same: one agent
reads the code, one reads the docs, one compares. Put it in
`.pi/pipelines/docs-drift.md`:

```markdown
---
name: docs-drift
description: One scout reads the code and one reads the guide on a topic, then one agent lists where they disagree
steps:
  - id: read
    fanOut: scout
    tasks:
      - Read the code under src/ only. Report what it does about the topic, one claim per line, with file and line.
      - Read docs/guide/ only. Report every claim the guide makes about the topic, quoted, with the page it comes from.
    concurrency: 2
  - id: compare
    reduce: synthesiser
---

## read

Read only, and stay in the directory your task names. Say plainly when you find
nothing about the topic there.

## compare

List every place where the documentation and the code disagree: one line each,
quoting the claim and naming the file that contradicts it. Where they agree, say
nothing. If they agree everywhere, say so in one line.
```

Frontmatter carries the structure: which combinators, which agents, which caps,
because that nests and YAML nests for free. The body carries the prose, one
`## <id>` section per step, because a ten-line instruction inside a YAML block
scalar is miserable to write and Markdown is what prose is for.

## See it loaded

```
/pipelines
```

```
build       chain → deliver - Locate the code, split the work, implement it in pairs, audit the whole
explore     fanOut → reduce - Three scouts read the code in parallel, then one agent answers from what they found
split       orchestrate → reduce - A planner splits a read-only question between a scout and a reviewer, then one agent answers
docs-drift  fanOut → reduce - One scout reads the code and one reads the guide on a topic, then one agent lists where they disagree
```

Yours sits beside the shipped ones. A file in `.pi/pipelines/` is visible from
this repository only; one in `~/.pi/agent/pipelines/` follows you everywhere.
The same name in both, and the repository's wins, so replacing a shipped
pipeline is writing a file called `build.md`, not deleting anything.

## Run it

```
/run docs-drift the default lifetime of a subagent, and who decides it
```

Two scouts, then the synthesiser, then the comparison lands in the
conversation, prefixed with the pipeline that produced it exactly as
[`explore`](02-three-scouts.md) was:

```
Result of the docs-drift pipeline, asked to: the default lifetime of a subagent, and who decides it.

They agree everywhere.

docs-drift: 2 steps, 3 turns - exported to /…/combo/runs/2026-09-19_10-37-18
```

One line, sixteen seconds, 24k input tokens for the whole run. An anticlimax is
the correct result of a drift check on a page that is right, and a pipeline
that only ever finds something is one you should distrust.

What the second step received is worth reading once, because it is the whole
data model. It is in the exported `usage.json`, under the synthesiser's `task`:

```markdown
List every place where the documentation and the code disagree: one line each,
quoting the claim and naming the file that contradicts it. Where they agree, say
nothing. If they agree everywhere, say so in one line.

## Request

the default lifetime of a subagent, and who decides it

## 1. scout
The default lifetime of a subagent is `"task"`.

The decision is made in `src/subagent.ts:148` using the following precedence:
1. The `lifetime` override passed in `SpawnOptions` to the `spawn` function.
2. The `lifetime` defined in the agent's frontmatter (`Agent.lifetime` in `src/agent.ts:48`).
3. The default value `"task"`.

## 2. scout
In `docs/guide/lifetime.md`:

- **Default lifetime**: `"task"`
  > `| "task" *(default)* | is born and dies with each task | …`
- **Who decides it**: It is decided by the explicit argument, then the agent's
  frontmatter, and finally defaults to `"task"`.
  > `Resolution order, always: the explicit argument, then the agent's frontmatter, then "task".`
```

Its own prose first, then the request, then the branches of the step before,
each labelled with the agent that wrote it. Nothing else.

The request travels to every step, not just the first. It once reached the
first step and stopped there, and a synthesiser answered "there is no question
asked in the prompt", because there was not. A `reduce` receives the previous
step's branches once, as a list, and is not also handed them as text, or every
report would arrive twice. Neither of those is anything you write down.

## What a typo costs

Change one letter and run it again:

```yaml
  - id: compare
    reduce: synthesizer
```

```
/run docs-drift the default lifetime of a subagent
```

```
Error: Unknown agent "synthesizer". Loaded agents: auditor, coder, committer,
explorer, interviewer, planner, reviewer, router, scout, synthesiser
```

It stopped before spawning anything. The file was parsed, every step's shape
was checked, every `## <id>` section was matched to a step and every agent
name was resolved against the roster, all before a single session opened. A
typo in step two costs a second, not a fan-out of real work followed by a
failure.

Now break the file itself: delete the `## compare` section and run
`/pipelines`:

```
docs-drift  BROKEN: /…/.pi/pipelines/docs-drift.md: step "compare" has no
"## compare" section in the body. (/…/.pi/pipelines/docs-drift.md)
```

A malformed pipeline is **never** silently skipped. An agent file missing its
`name` is dropped without a word, following pi, because agents are discovered;
a pipeline is asked for by name, and answering "unknown pipeline" about a file
sitting right there would be a lie. The most likely reason anyone runs
`/pipelines` is that something did not load, so the broken ones are what the
listing is for.

## What the file cannot say

There is no `if`, no `when`, no way to name step one's output from step three.
Each step is handed three things, in named sections: its instruction, the
request, and the previous step's output. Nothing else flows.

- A `loop` step whose `until` never converges **fails the pipeline** rather
  than handing unconverged work to the next step.
- A `reduce` **folds the step before it**, and a `reduce` with nothing to fold
  fails without spawning.
- `verify: [npm, test]` at the top level names the project's check as a list,
  never a command line, because splitting `"npm test"` on whitespace is
  writing a small shell.
- `model: some/model` at the top level puts every subagent of the file on one
  model, and a `--model` on the command beats it.

When you need more than that, the same two steps in TypeScript are eight lines
and every combinator the file can name is a function you can call. That is
where [Workflows](../guide/workflows.md) picks up. The rest of this file's
vocabulary is in [From pipelines to flows](../guide/from-pipelines.md).

The pipeline used our agents. The next page writes one of yours, and the first
thing it decides is what the agent may not do.

**Next:** [An agent that cannot do harm](05-an-agent-that-cannot-write.md).
