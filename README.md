<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="docs/_static/logo/combo-lockup-dark.svg">
    <img src="docs/_static/logo/combo-lockup-light.svg" alt="combo" height="46">
  </picture>
</h1>

> A combo is several moves that land as one. So is a workflow here: subtasks run
> apart, and come back as a single `Result`.

[pi](https://pi.dev) is a coding agent that ships an SDK: a session can be started
inside your own process rather than driven through a terminal. combo is the layer
above it. A Markdown file becomes an **agent**, an agent becomes a **subagent
whose lifetime you control**, and subagents compose into **workflows written in
TypeScript**.

Reach for it when one agent is not enough: a coder and a reviewer looping until
they agree, three scouts reading a codebase in parallel, the same workflow run
against four models to see which one is worth its price.

- **In-process subagents**, isolated and composable in TypeScript. Their tools
  and their skills are named in their own file, never inherited from yours.
- An **explicit lifetime**: disposable, or persistent across a workflow. The
  caller decides, never the library.
- A **live view** of the work, in [herdr](https://herdr.dev) if it is running and
  in pi's TUI otherwise, with no change to the calling code. A herdr split
  reads like a pi session, and takes the keyboard while its subagent works.
- **Everything measured and exportable**: time and tokens per subagent, plus a
  readable HTML and replayable JSONL export of a whole run.
- An **answer in the language you asked in**. The definitions are English; what
  comes back follows the question, and the words a workflow reads back stay put.

## Getting started

```bash
npm install @ai-for-dev/combo       # the library
pi install npm:@ai-for-dev/combo    # the same package, loaded into pi
```

Node 23.6 or later runs TypeScript natively: there is no build step, and the
package ships the TypeScript it was written in.

From a clone, `npm install` then `npm test` - offline, no network calls.

```typescript
import { findAgent, loadAgents, run } from "@ai-for-dev/combo";

const agents = loadAgents();
const result = await run(findAgent(agents, "scout"), "Find the authentication code");
result.ok; // a model failure is a Result, never a throw
```

Everything returns that same `Result` - `{ agent, output, messages, usage, ok,
error? }` - which is the one contract that makes workflows composable.

**[Quickstart](docs/guide/quickstart.md)** is the guided version: a disposable
subagent, one that remembers, a workflow, and the same thing from inside pi.

## Workflows

Eight combinators - `chain`, `fanOut`, `loop`, `reduce`, `route`,
`orchestrate`, `interview`, `swarm` - all taking the same options and all
returning `Result`s.

```typescript
const { results, usage } = await fanOut({ agent: scout, tasks, concurrency: 2 });
usage.busyMs / usage.wallMs;   // the parallelism actually achieved

const review = await loop({
	steps: [coder, reviewer],
	input: "Implement the parser",
	until: (step) => saysWord(step.output, "LGTM"),
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
The nearest override wins: argument, then the flow file, then the agent's
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

## The whole flow: request to working tree

```
/run build add a cache in front of the agent loader

  locate      a scout maps the code the request touches
  plan        a planner splits it into subtasks
  deliver     up to two rounds of:
    work        a coder and a reviewer per subtask, each pair in a copy of the repository
    tests       .pi/checks/test.sh, your project's own script; its verdict is final
    audit       one agent reads the whole change against the request
```

It asks nothing on the way, and it commits nothing at the end: the work stays in
the working tree for you to read, and the answer lands in the conversation. An
interrupted run carries on with `/run resume`, from the first visit that did
not end. `/run build-attended` interviews you first, asks "Build this?", and
commits on the run's own branch.

What runs is a **flow**: a task graph in YAML and Markdown, next to your
agents, checked whole before its first spawn and walked by our code. The
package ships `build`, `build-attended`, `explore`, `split` and `interview`, so
`/run` works as soon as the extension is loaded; drop a `build.md` in
`.pi/flows/` and yours replaces the shipped one, with no code to change.

See [Deliver a change](docs/guide/build.md) and [Flows](docs/guide/flows.md).

## Using it from pi

```bash
pi install npm:@ai-for-dev/combo   # the tool, the commands, the agents
pi -e extension                    # from a clone, this session only
```

```
> /run build add a slugify helper with tests
> /run explore where is the condition language implemented?
> use subagent to review src/usage.ts with coder then reviewer, looping until LGTM
> use subagent to run the interview flow on "add a --verbose flag to the driver"
> /swarm --members 3 describe each file under src/reporters/, in two sentences
> /agents        # who can be spawned here, and from which directory
> /flows         # the flows, what each can cost, and the files refused
> /flows build   # one flow's plan, node by node
```

Every `/run` gets a run directory, `runs/<timestamp>/`, with its journal, its
transcripts and what it cost; the plan fills above the prompt as the visits
go. The `subagent` tool runs a flow by name too, and puts its questions to
you during the model's turn. See [Flows](docs/guide/flows.md), and
[From pipelines to flows](docs/guide/from-pipelines.md) for a pipeline of your
own.

`/swarm` puts several copies of one agent on one job, with a board between
them and nobody dividing the work: they take what they will do. It ends on
coverage of what `--claim` names, or on the members voting the same way with
`--until agree`. See [Swarms](docs/guide/swarm.md).

While the subagents work, a dot per subagent sits above the prompt with its
model, tokens and a clock counting up live; the tool row below holds the record.
That list is also how they are called off: `esc` stops every one of them,
`ctrl+↑↓` picks one and `ctrl+del` stops it, and `/stop scout#2` names it
outright. What ran up to that point is kept.

Or walk the chain yourself, one command at a time, with this session kept out of
it until you say otherwise:

```
> /step explore how usage is measured
> /step planner three steps at most      # handed what the explorer found
> /step coder
> /quote                                 # only now does the session read any of it
```

See [Extension](docs/guide/extension.md),
[Walk a chain by hand](docs/guide/chain-by-hand.md) and
[Display](docs/guide/display.md).

## Documentation

- [Manual](docs/index.md) - agents, lifetime, workflows, flows, display, export, experiments.
- [Tutorials](docs/tutorials/index.md) - twelve sittings in front of pi, one
  problem each, every one run on this repository.
- [API reference](docs/reference/api/index.md) - every public export, generated from the
  source and checked by the test suite.
- [Examples](docs/reference/examples.md) - one runnable script per shape.
- [Design decisions](docs/decisions.md) - the decisions, and the ones that were
  reversed.
- [`NEXT.md`](NEXT.md) - what is left, and the traps already paid for.

The same pages build into a site: `make -C docs html`, with
[docs/README.md](docs/README.md) for the how and the why. Sphinx is a
documentation dependency only - the library still depends on the pi SDK alone.
