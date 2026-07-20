# pi-subagent

Write [pi](https://pi.dev) subagents and compose workflows, without rewriting the
plumbing every time.

- **In-process subagents**, isolated and composable in TypeScript.
- An **explicit lifetime**: disposable, or persistent across a workflow. The
  caller decides, never the library.
- A **live view** of the work, in [herdr](https://herdr.dev) if it is running and
  in pi's TUI otherwise, with no change to the calling code.
- **Everything measured and exportable**: time and tokens per subagent, plus a
  readable HTML and replayable JSONL export of a whole run.

The full manual is in [`docs/`](docs/index.md). The intent behind the design and
every decision that shaped it live in [`AGENTS.md`](AGENTS.md).

## Getting started

```bash
npm install
npm test          # offline, no network calls
npm run typecheck
```

Node 23.6 or later runs TypeScript natively: there is no build step.

```typescript
import { findAgent, loadAgents, run } from "pi-subagent";

const agents = loadAgents();
const result = await run(findAgent(agents, "scout"), "Find the authentication code");
```

The low level form gives you a live subagent whose lifetime you control:

```typescript
import { spawn } from "pi-subagent";

const coder = await spawn(coderAgent, { lifetime: "workflow" });
try {
	await coder.ask("Implement the parser");
	await coder.ask("Apply these remarks: …");   // it remembers the previous turn
} finally {
	await coder.close();
}
```

Both return the same `Result`: `{ agent, output, messages, usage, ok, error? }`.
It is the one shared contract, and it is what makes workflows composable.

See [Quickstart](docs/quickstart.md).

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

See [Workflows](docs/workflows.md) and [Lifetime](docs/lifetime.md).

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

See [Deliver a change](docs/build.md) and [Pipelines](docs/pipelines.md).

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

See [Extension](docs/extension.md) and [Display](docs/display.md).

## Documentation

- [Manual](docs/index.md) - agents, lifetime, workflows, pipelines, display, export.
- [API reference](docs/api/index.md) - every public export, generated from the
  source and checked by the test suite.
- [Examples](docs/examples.md) - one runnable script per shape.
- [`AGENTS.md`](AGENTS.md) - the decisions, and the ones that were reversed.
- [`NEXT.md`](NEXT.md) - what is left, and the traps already paid for.
