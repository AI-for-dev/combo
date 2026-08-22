# combo documentation

combo is a small TypeScript library for writing [pi](https://pi.dev)
subagents and composing them into workflows: orchestrator, fan-out, chain,
coding/review loop, and a full delivery pipeline. Subagents run **in-process**,
through pi's SDK, so a subagent is an object with a lifetime you control rather
than a process you parse.

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

## Start here

- [Quickstart](guide/quickstart.md) - the first subagent, the first workflow, the first build.
- [Agents](guide/agents.md) - defining an agent in Markdown, tools, scopes.
- [Lifetime](guide/lifetime.md) - the central choice: disposable or persistent.
- [Workflows](guide/workflows.md) - the nine combinators and the options they share.
- [Pipelines](guide/pipelines.md) - a workflow written in Markdown, next to your agents.
- [Deliver a change](guide/build.md) - interview, plan, pair, check, audit, commit.

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
