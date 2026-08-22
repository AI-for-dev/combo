# combo

[pi](https://pi.dev) is a coding agent that ships an SDK: a session can be started
inside your own process rather than driven through a terminal. combo is the layer
above it. A Markdown file becomes an **agent**, an agent becomes a **subagent
whose lifetime you control**, and subagents compose into **workflows written in
TypeScript**.

Reach for it when one agent is not enough: a coder and a reviewer looping until
they agree, three scouts reading a codebase in parallel, the same workflow run
against four models to see which one is worth its price.

- **In-process subagents**, isolated and composable in TypeScript.
- An **explicit lifetime**: disposable, or persistent across a workflow. The
  caller decides, never the library.
- A **live view** of the work, in [herdr](https://herdr.dev) if it is running and
  in pi's TUI otherwise, with no change to the calling code.
- **Everything measured and exportable**: time and tokens per subagent, plus a
  readable HTML and replayable JSONL export of a whole run.

## Getting started

```bash
npm install
npm test          # offline, no network calls
```

Node 23.6 or later runs TypeScript natively: there is no build step.

```typescript
import { findAgent, loadAgents, run } from "combo";

const agents = loadAgents();
const result = await run(findAgent(agents, "scout"), "Find the authentication code");
result.ok; // a model failure is a Result, never a throw
```

Everything returns that same `Result` - `{ agent, output, messages, usage, ok,
error? }` - which is the one contract that makes workflows composable.

**[Quickstart](docs/guide/quickstart.md)** is the guided version: a disposable
subagent, one that remembers, a workflow, and the same thing from inside pi.

## Workflows

Nine combinators - `chain`, `fanOut`, `loop`, `reduce`, `route`, `orchestrate`,
`pair`, `interview`, `deliver` - all taking the same options and all returning
`Result`s.

```typescript
const { results, usage } = await fanOut({ agent: scout, tasks, concurrency: 2 });
usage.busyMs / usage.wallMs;   // the parallelism actually achieved

const review = await loop({
	steps: [coder, reviewer],
	input: "Implement the parser",
	until: (step) => step.output.includes("LGTM"),
	lifetime: "workflow",       // the reviewer remembers what it already said
});
review.converged;               // did it reach the bar, or just run out of iterations?
```

A failure does not crash a workflow: it becomes a `Result` with `ok: false`.
`timeoutMs` is a per-turn deadline with no default, and you want one on anything
unattended - pi's agent loop has no step cap.

The **model is a knob at every level**: `model` on a spawn or a workflow puts
every subagent on one model, whatever their frontmatter says - which is what
lets the same workflow run against different LLMs with no agent file edited.
The nearest override wins: argument, then the pipeline file, then the agent's
frontmatter, then pi's own settings. No environment variable, anywhere.

```typescript
await loop({ steps: [coder, reviewer], input, model: "anthropic/claude-sonnet-5" });
```

See [Workflows](docs/guide/workflows.md) and [Lifetime](docs/guide/lifetime.md).

## Comparing models

`experiment` runs the same workflow over M models and N repetitions, each cell in
its own directory with its own measurements, and gives back one table.

```typescript
const report = await experiment({
	models: ["anthropic/claude-sonnet-5", "local/qwen/qwen3-coder-next"],
	repetitions: 3,
	run: async (cell) => {
		const result = await loop({ ...cell.options, steps: [coder, reviewer], input, until: lgtm });
		return { ok: result.ok, converged: result.converged };
	},
});
```

Cells run one at a time by default, failed ones stay in the report with their
usage, and the flag columns are whatever the callback returned. See
[Experiments](docs/guide/experiments.md).

## The whole flow: question to commit

```
/build add a cache in front of the agent loader

  interview   one question at a time, until you submit   -> a brief
  plan        who does what, validated before anything spawns
  pair        a worker and a reviewer per subtask, until accepted
  check       your own command runs; its verdict is final
  audit       one agent reads the whole, names what still has to change
  commit      an agent writes the message, this code makes the commit
```

It stops exactly twice: the brief before any work starts, the commit before
anything reaches history. An interrupted build resumes with `/build resume`, and
only approved subtasks survive.

What runs between the two stops is a **pipeline**: a Markdown file, next to your
agents, that says which combinators run in which order. The package ships one, so
`/build` works as soon as the extension is loaded; drop a `build.md` in
`.pi/pipelines/` and yours replaces it, with no code to change.

See [Deliver a change](docs/guide/build.md) and [Pipelines](docs/guide/pipelines.md).

## Using it from pi

```bash
pi -e extension          # this session only
pi install ./extension   # permanently, via settings
```

```
> /build add a slugify helper with tests
> use subagent to review src/usage.ts with coder then reviewer, looping until LGTM
```

While the subagents work, a dot per subagent sits above the prompt with its
model, tokens and a clock counting up live; the tool row below holds the record.

See [Extension](docs/guide/extension.md) and [Display](docs/guide/display.md).

## Documentation

- [Manual](docs/index.md) - agents, lifetime, workflows, pipelines, display, export, experiments.
- [API reference](docs/reference/api/index.md) - every public export, generated from the
  source and checked by the test suite.
- [Examples](docs/reference/examples.md) - one runnable script per shape.
- [Design decisions](docs/decisions.md) - the decisions, and the ones that were
  reversed.
- [`NEXT.md`](NEXT.md) - what is left, and the traps already paid for.
