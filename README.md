# pi-subagent

Write [pi](https://pi.dev) subagents and compose workflows, without rewriting
the plumbing every time.

The intent behind the project and its structural decisions live in
[`AGENTS.md`](AGENTS.md). This file only says how to use it.

## Getting started

```bash
npm install
npm test          # 180 tests, no network calls
npm run typecheck
```

Node ≥ 23.6 runs TypeScript natively: there is no build step.

## Two levels of API

The low level gives you a live subagent whose lifetime you control:

```typescript
import { spawn, loadAgents, findAgent } from "pi-subagent";

const agents = loadAgents();
const coder = await spawn(findAgent(agents, "coder"), { lifetime: "workflow" });
try {
	await coder.ask("Implement the parser");
	await coder.ask("Apply these remarks: …"); // it remembers the previous turn
	console.log(coder.usage); // cumulative since spawn
} finally {
	await coder.close();
}
```

The high level is disposable, and handles everything:

```typescript
import { run } from "pi-subagent";

const result = await run(scout, "Find the authentication code");
```

Both return the same `Result`: `{ agent, output, messages, usage, ok, error? }`.
It is the one shared contract, and it is what makes workflows composable.

## Lifetime

The central choice of the project. It is **explicit and local**: the argument
wins over the agent's frontmatter, which wins over the default.

| `lifetime` | The subagent… | When |
|-----------|----------------|-------|
| `"task"` *(default)* | is born and dies with each task | exploration, fan-out, independent tasks |
| `"workflow"` | lives for the workflow | coding↔review loop, iterative refinement |
| `"session"` | lives as long as the pi session | "companion" agent consulted several times |

Same workflow, two regimes, one parameter:

```typescript
// "team": the reviewer does not repeat its remarks, the coder remembers them
await chain({ steps: [coder, reviewer, coder], input: task, lifetime: "workflow" });

// "freshness": brand new subagents at every step, no accumulated bias
await chain({ steps: [coder, reviewer, coder], input: task, lifetime: "task" });
```

**Whoever opens, closes.** The owner of a `Subagent` is whoever `spawn()`ed it.
A workflow closes everything it created in a `finally`, cancellation included;
it never closes what it was handed.

## Workflows

Three combinators for now. A combinator is added when a real example needs it,
not before.

```typescript
// chain: 1→1→1, the output of n is the input of n+1
const result = await chain({ steps: [scout, reviewer], input: "…" });
result.steps; // the intermediate results

// fanOut: 1→N, bounded concurrency, results in task order
const { results, usage } = await fanOut({ agent: scout, tasks, concurrency: 2 });
usage.busyMs / usage.wallMs; // the parallelism actually achieved

// loop: 1→1, until a judge is satisfied
const review = await loop({
	steps: [coder, reviewer],
	input: "Implement the parser",
	until: (step) => step.output.includes("LGTM"),
	maxIterations: 5, // defaults to 5; "forever" is never reachable
	lifetime: "workflow", // the reviewer remembers what it already said
});
review.converged; // did it reach the bar, or just run out of iterations?
```

`loop` reports `converged` separately from `ok`, because they answer different
questions: `ok` says the last turn ran without a model error, `converged` says
the work reached the bar. Exhausting `maxIterations` with every turn technically
fine is `ok: true, converged: false` - and that distinction is the only thing
worth knowing.

They all accept the same options:
`{ lifetime, signal, timeoutMs, openInHerdr, onEvent, bus, cwd, sessionDir, spawn }`.

**A failure does not crash the workflow**: it becomes a `Result` with
`ok: false`. In a fan-out the other branches carry on, unless `failFast`.

## Deadlines

One `ask` is one `session.prompt()`, and pi's agent loop has **no step cap**: it
runs as long as the model keeps requesting tools. A model that hallucinates a
tool name, gets "unknown tool" back and asks again will loop until something
stops it. Nothing will, unless you say so:

```typescript
await coder.ask(task, { timeoutMs: 120_000 });
await fanOut({ agent: scout, tasks, timeoutMs: 60_000 }); // per branch, not total
```

There is no default. The library does not get to decide that a legitimate task
took too long - but you should set one on anything unattended.

## Measurements

Tokens and cost come from pi; time is measured here, on a monotonic clock.
Nothing is estimated by counting characters: a field the provider does not
report is `0`, and we say so.

```typescript
subagent.usage; // cumulative since spawn
result.usage;   // this turn only
```

Because `getSessionStats()` is cumulative, a turn's usage is the **difference**
between two snapshots. On a persistent agent, the gap between `wallMs` and
`busyMs` is the interesting information: waiting time versus useful time.

A fan-out **aggregates**: `busyMs` is the sum of the branches, `wallMs` the real
duration. Their ratio is the parallelism.

## Defining an agent

Markdown + frontmatter, following pi's convention (`~/.pi/agent/agents/*.md`,
`.pi/agents/*.md`):

```markdown
---
name: reviewer
description: Reviews code and returns actionable remarks
tools: read, grep, find, ls
model: anthropic/claude-sonnet-5
lifetime: workflow
---

You review the code produced and return at most 5 remarks…
```

`name` and `description` are mandatory; a file without them is ignored silently.
Without `tools`, the subagent is read-only (`read`, `grep`, `find`, `ls`) - the
recommended default for exploration.

`loadAgents()` only loads user agents. Project agents (`.pi/agents/`) are
repository-controlled content: ask for them explicitly with `scope: "project"`
or `"both"`.

## Display

Display is an **observer, never a participant**. Unplug every reporter and the
result is identical.

```typescript
await fanOut({ agent: scout, tasks, onEvent: (event) => console.log(event) });
```

A reporter that throws is swallowed: it cannot take a workflow down.

### Watching subagents in herdr

Inside [herdr](https://herdr.dev), a subagent can get **its own split** and show
you what it is doing:

```typescript
await fanOut({
	agent: scout,
	tasks,
	concurrency: 3,
	openInHerdr: true,   // opt-in, per subagent
	onEvent: autoReporter(),
});
```

`autoReporter()` picks herdr when it is running and stays silent otherwise -
the same code runs either way, with no warning when herdr is absent.

A herdr pane cannot host an in-process subagent: there is no process and no TTY
to attach. So the pane does not host it - it tails a file we write, showing tool
calls, streamed text, and the final usage line. Splits close on their own when
their subagent does.

`openInHerdr` is opt-in per subagent, like `lifetime`: a fan-out of twenty
branches will not carpet your screen unless you asked for it. It can also be a
default on the agent itself, which is often what you want - a scout is worth
watching whoever calls it:

```markdown
---
name: scout
description: Locates the code relevant to a question
tools: read, grep, find, ls
openInHerdr: true
---
```

`onEvent` takes a single listener, so watching in two places at once needs
composing:

```typescript
onEvent: combineReporters(collector.reporter, createHerdrReporter());
```

`createHerdrReporter()` returns `undefined` outside herdr, and
`combineReporters` drops it.

## Using it from pi

The extension exposes everything above as a `subagent` tool the model can call,
rendered live in pi's TUI.

```bash
pi -e extension                      # this session only
pi install ./extension               # permanently, via settings
```

Works with pi 0.80.6 (what Homebrew ships) and 0.80.10 (npm): those two
disagree on the model API, and `src/session.ts` detects which one it is running
inside. Note that an extension resolves **pi's own copy** of the package, not
this repository's `node_modules` - the version that matters is the pi you
launched.

```
> use subagent to review src/usage.ts with coder then reviewer, looping until LGTM
```

While the subagents work, a dot per subagent sits just above the prompt:

```
● scout#1  grep /lifetime/
  ilaas/qwen-3.6-35b-instruct · ↑12k ↓209 · 12.4s
✓ scout#2  done
  ilaas/qwen-3.6-35b-instruct · ↑8k ↓150 · 8.1s
```

`●` while it works, `✓` when it succeeded, `✗` when it failed, coloured by
status; the dimmed line underneath carries model, tokens and elapsed time,
counting up live. The widget disappears the moment the work ends - the full
record is one line below, in the tool row.

That collapsed row shows one line per subagent with its last tool calls; expand
it (the hint comes from your own keybinding config, not a hard-coded `Ctrl+O`)
for the full task, every tool call, the output as Markdown, and usage per
subagent. A parallel run shows the parallelism it achieved; a loop says whether
it **converged** or merely ran out of iterations.

Agents come from `~/.pi/agent/agents/` by default. This repository ships its
demo agents in `.pi/agents/`, so ask for them explicitly:

```
> use subagent with scope "project" and agent "scout" to find the auth code
```

That is deliberate: project agents are repository-controlled content, so they
are never loaded by default.

## Examples

Directly executable, one per shape:

```bash
node examples/01-run.ts       # disposable
node examples/02-chain.ts     # the same chain in "task", then in "workflow"
node examples/03-fan-out.ts   # 3 tasks, 2 at a time
node examples/04-loop.ts      # coding ↔ review, as a team then with fresh eyes
node examples/05-herdr.ts     # a fan-out with one herdr split per branch
```

Not every provider reports tokens - several return zero. For the usage lines to
mean anything, pick one that does:

```bash
PI_SUBAGENT_MODEL=local/qwen/qwen3-coder-next node examples/03-fan-out.ts
```

## Status

Shipped so far: the foundation - `Agent`, `Subagent`, `Result`, `Usage`, the
event bus - three combinators (`chain`, `fanOut`, `loop`), the reporters (herdr,
TUI, console, silent), and the pi extension.

Still to come: session export (`runs/<timestamp>/`), and the `orchestrate`,
`route` and `reduce` combinators. See [`NEXT.md`](NEXT.md) for what is left and
the traps already paid for.
