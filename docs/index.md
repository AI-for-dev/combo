# pi-subagent documentation

pi-subagent is a small TypeScript library for writing [pi](https://pi.dev)
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

## Quick start

```bash
npm install
npm test          # offline, no network calls
npm run typecheck
```

Node 23.6 or later runs TypeScript natively, so there is no build step.

```typescript
import { findAgent, loadAgents, run } from "pi-subagent";

const agents = loadAgents();
const result = await run(findAgent(agents, "scout"), "Find the authentication code");
console.log(result.output, result.usage);
```

Then, from pi itself:

```bash
pi -e extension
/build add a slugify helper with tests
```

See [Quickstart](quickstart.md) for the full first run.

## Start here

- [Quickstart](quickstart.md) - the first subagent, the first workflow, the first build.
- [Agents](agents.md) - defining an agent in Markdown, tools, scopes.
- [Lifetime](lifetime.md) - the central choice: disposable or persistent.
- [Workflows](workflows.md) - the nine combinators and the options they share.
- [Pipelines](pipelines.md) - a workflow written in Markdown, next to your agents.
- [Deliver a change](build.md) - interview, plan, pair, check, audit, commit.

## Watching and measuring

- [Display](display.md) - reporters, herdr splits, the pi TUI widget.
- [Measurements](measurements.md) - what `Usage` counts, and what it refuses to guess.
- [Export](export.md) - `runs/<timestamp>/`, HTML, JSONL, `usage.json`.

## Using it from pi

- [Extension](extension.md) - the `subagent` tool, `/interview`, `/build`, `/herdr`.

## Reference

- [API reference](api/index.md) - every public export, generated from the source.
- [Examples](examples.md) - one runnable script per shape.

## Development

- [Development](development.md) - tests, typechecking, conventions, how the docs stay honest.
- [Design decisions](../AGENTS.md) - why the library is shaped this way, and what was reversed.
