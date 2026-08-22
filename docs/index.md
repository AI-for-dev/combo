---
myst:
  html_meta:
    "description": "combo - write pi subagents and compose them into workflows, in TypeScript."
---

# combo

> A combo is several moves that land as one. So is a workflow here: subtasks run apart, and
> come back as a single `Result`.

combo is a small TypeScript library for writing [pi](https://pi.dev) subagents and composing
them into workflows: orchestrator, fan-out, chain, coding/review loop, and a full delivery
pipeline. Subagents run **in-process**, through pi's SDK, so a subagent is an object with a
lifetime you control rather than a process you parse.

Four things it promises:

1. **In-process subagents**, isolated and composable in TypeScript.
2. An **explicit lifetime**: disposable, or persistent across a workflow. The
   caller decides, never the library.
3. A **live view** of the work, in [herdr](https://herdr.dev) if it is running
   and in pi's TUI otherwise, with no change to the calling code.
4. **Everything measured and exportable**: time and tokens per subagent, plus a
   readable HTML and replayable JSONL export of a whole run.

The first hour is [Quickstart](guide/quickstart.md): installing, one disposable
subagent, one that remembers, a workflow, and the same thing from inside pi. It is
the only page that opens with a first example - everything here builds on it
rather than restating it.

:::{admonition} Where the line is drawn
:class: important

**Agents are data, workflows are code.** An agent is Markdown with frontmatter, a workflow
is TypeScript combinators, and a pipeline is a workflow written down. There is no YAML DSL,
and an agent never writes a pipeline.

**A prompt is not a permission boundary.** A subagent that must not write gets no `write`
tool - asking it nicely has been tried, and it edited the repository anyway. The agents
produce text; this library performs the act.

[Design decisions](decisions.md) has the rest, each with the reason it was taken - and the
reversals, with theirs.
:::

## Start here

::::{grid} 1 1 2 2
:gutter: 3

:::{grid-item-card} {octicon}`rocket` Quickstart
:link: guide/quickstart
:link-type: doc

The first subagent, the first workflow, the first build.
:::

:::{grid-item-card} {octicon}`file-badge` Agents
:link: guide/agents
:link-type: doc

Defining an agent in Markdown: frontmatter, tools, scopes.
:::

:::{grid-item-card} {octicon}`clock` Lifetime
:link: guide/lifetime
:link-type: doc

The central choice: disposable or persistent, and who closes what.
:::

:::{grid-item-card} {octicon}`git-merge` Workflows
:link: guide/workflows
:link-type: doc

The nine combinators, and the options they all share.
:::

:::{grid-item-card} {octicon}`checklist` Pipelines
:link: guide/pipelines
:link-type: doc

A workflow written in Markdown, next to your agents.
:::

:::{grid-item-card} {octicon}`package` Deliver a change
:link: guide/build
:link-type: doc

Interview, plan, pair, check, audit, commit.
:::
::::

## Watching and measuring

- [Display](guide/display.md) - reporters, herdr splits, the pi TUI widget.
- [Measurements](guide/measurements.md) - what `Usage` counts, and what it refuses to guess.
- [Export](guide/export.md) - `runs/<timestamp>/`, HTML, JSONL, `usage.json`.
- [Experiments](guide/experiments.md) - one workflow, M models, N repetitions, one table.

## Using it from pi

- [Extension](guide/extension.md) - the `subagent` tool, `/interview`, `/build`, `/herdr`.

## Reference

- [API reference](reference/api/index.md) - every public export, generated from the source.
- [Examples](reference/examples.md) - one runnable script per shape.

## Development

- [Development](development.md) - tests, typechecking, conventions, how the docs stay honest.
- [Design decisions](decisions.md) - why the library is shaped this way, and what was reversed.

## In one page

```bash
npm install
npm test          # offline, no network calls
```

```{code-block} typescript
:caption: One subagent, then two of them arguing until they agree

import { findAgent, loadAgents, loop, run } from "combo";

const agents = loadAgents();
const scout = findAgent(agents, "scout");

const result = await run(scout, "Find the authentication code");
result.ok;                      // a model failure is a Result, never a throw

const review = await loop({
	steps: [findAgent(agents, "coder"), findAgent(agents, "reviewer")],
	input: "Implement the parser",
	until: (step) => step.output.includes("LGTM"),
	lifetime: "workflow",       // the reviewer remembers what it already said
	timeoutMs: 300_000,         // no default: pi's agent loop has no step cap
});
review.converged;               // reaching the cap is not success
```

```{toctree}
:maxdepth: 2
:caption: User guide
:hidden:

guide/quickstart
guide/agents
guide/lifetime
guide/workflows
guide/pipelines
guide/build
guide/display
guide/measurements
guide/export
guide/experiments
guide/extension
```

```{toctree}
:maxdepth: 2
:caption: Reference
:hidden:

reference/api/index
reference/examples
```

```{toctree}
:maxdepth: 1
:caption: Development
:hidden:

development
decisions
```
