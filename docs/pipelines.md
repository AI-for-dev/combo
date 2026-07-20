# Pipelines

A pipeline is a workflow **you write in Markdown**, next to your agents. It says
which combinators run, in which order, with which agents and which caps - and
our code walks it. No agent reads the file to decide what happens next.

```markdown
---
name: build
description: Plan the brief, build each subtask as a pair, check it, then audit
verify: [npm, test]
steps:
  - id: work
    deliver: planner
    workers: [coder]
    reviewer: reviewer
    auditor: auditor
---

## work

Deliver what the brief below asks for, and nothing beyond it.
```

Frontmatter holds the **structure**, because it is real YAML and nesting comes
free. The body holds the **prose**, one `## <id>` section per step: a ten-line
instruction inside a YAML block scalar is indentation-sensitive and miserable to
write, and prose is the one thing Markdown is actually for.

## Where they live

The same convention as [agents](agents.md), so there is nothing new to learn:

| Location | Scope | Loaded |
| --- | --- | --- |
| `~/.pi/agent/pipelines/*.md` | `"user"` | by default |
| `.pi/pipelines/*.md` | `"project"` | on explicit request |

A repository's pipelines carry prose that becomes an instruction to a model, so
they are third-party instructions and follow the agent rule exactly:
`scope: "both"` or `"project"`, never by default. `/build` passes `"both"`,
because a user typing it inside a repository *is* the explicit request.

Where it differs from agents: **a malformed pipeline is never ignored.** An agent
is discovered, so an incomplete file is dropped in silence. A pipeline is asked
for by name, so answering "unknown pipeline" about a file sitting right there
would be a lie. One broken file does not hide the others either - the failure is
raised when, and only when, that file is the one being asked for.

## What a step may say

| Field | For | Meaning |
| --- | --- | --- |
| `id` | all | Joins the entry to its `## <id>` section. Unique. |
| one of `chain`, `fanOut`, `loop`, `reduce`, `route`, `orchestrate`, `pair`, `deliver` | all | The combinator, carrying its agents. Exactly one per step. |
| `workers` | `orchestrate`, `deliver` | Who may be assigned a subtask. |
| `reviewer`, `auditor` | `deliver` | The reviewer paired with every worker; the agent that reads the finished whole. |
| `destinations`, `fallback` | `route` | The candidates, and who takes it when the router names nobody. |
| `tasks` | `fanOut` | The branches, spelled out. |
| `until` | `loop` | Converged when the output contains this text. |
| `lifetime`, `openInHerdr`, `timeoutMs` | all | Override the run's own, for this step. |
| `concurrency`, `failFast`, `maxIterations`, `maxRounds`, `maxTasks`, `maxAuditRounds` | as applicable | The caps. Same defaults as [the combinators](workflows.md). |

At the top level, `verify: [npm, test]` states the project's check once. It is a
list rather than a command line, because splitting `"npm test"` on whitespace is
writing a small shell, and the check runs with no shell precisely so that an
argument stays an argument.

## What a pipeline is not

A programming language. There is no `if`, no `when`, no `${{ steps.x.output }}`.
**Steps are linear, and each one receives the previous one's output** - that is
the whole dataflow. A step is handed its own prose, then what reached it:

```
<the ## section>

---

<the previous step's output>
```

The moment a run needs a branch, a condition or a reference back to step two, it
is a TypeScript [workflow](workflows.md), not a file. That line is what keeps
"agents are data, workflows are code" true while still letting a pipeline be
written in Markdown.

Two conveniences follow from the linear rule:

- **`reduce` folds the step before it.** A `fanOut` or an `orchestrate` exposes
  its branches, and the next `reduce` synthesises them. A `reduce` with nothing
  to fold fails without spawning anything.
- **A `loop` with an `until` that never converges fails the pipeline.** Handing
  the next step work that never reached its bar is exactly the silent failure
  `converged` exists to expose.

## What it costs to get wrong

Nothing, and that is deliberate. Before a single session is opened:

- the file is parsed, and the shape of every step is checked (a `pair` has two
  agents, a `route` has at least two destinations, a `fanOut` has literal tasks);
- every `## <id>` section is matched to a step, in both directions - a renamed id
  on one side only is otherwise silent, and the step would run with no
  instruction at all;
- **every agent name is resolved** against the roster.

A typo in step four therefore costs a second, not three steps of real work.

## Running one

`/build` runs a pipeline. With no `build.md` of your own it runs a built-in
default, which is the flow `/build` has always had, expressed as data - there is
exactly one code path, so there is nothing to drift.

```
/build add a cache in front of the agent loader
/build --pipeline audit check what the parser does with an empty file
/build resume
```

The two stops are unchanged: the brief before any work starts, the commit before
anything reaches history. The pipeline covers what happens between them. See
[Deliver a change](build.md).

From a script:

```typescript
import { checkPipelineAgents, findPipeline, loadAgents, loadPipelines, runPipeline } from "pi-subagent";

const agents = loadAgents({ scope: "both" });
const pipeline = findPipeline(loadPipelines({ scope: "both" }), "build");
checkPipelineAgents(pipeline, agents);   // pay for a typo before the work, not after

const done = await runPipeline({ pipeline, agents, input: brief });
done.steps.map((step) => step.id);
done.ok;
```

`runPipeline` never runs a command itself. A pipeline may *name* a check, and
turning that into something that runs is the caller's decision, because it is the
caller who owns the working tree - so `verify` arrives as a port.

## Resuming

`deliver` steps report their progress and can be carried on, keyed by step id, so
a two-delivery pipeline never hands the second one the first one's approved
subtasks. What survives an interruption, and what deliberately does not, is
covered in [Deliver a change](build.md).

## Reference

- [`pipeline`](api/pipeline.md) - `parsePipeline`, `Pipeline`, `PipelineStep`, `STEP_KINDS`.
- [`pipeline-load`](api/pipeline-load.md) - `loadPipelines`, `findPipeline`.
- [`workflows/pipeline-run`](api/workflows/pipeline-run.md) - `runPipeline`, `checkPipelineAgents`.
