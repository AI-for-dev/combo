# pi-subagent

Write [pi](https://pi.dev) subagents and compose workflows, without rewriting
the plumbing every time.

The intent behind the project and its structural decisions live in
[`AGENTS.md`](AGENTS.md). This file only says how to use it.

## Getting started

```bash
npm install
npm test          # 82 tests, no network calls
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

Two combinators for now. A combinator is added when a real example needs it,
not before.

```typescript
// chain: 1→1→1, the output of n is the input of n+1
const result = await chain({ steps: [scout, reviewer], input: "…" });
result.steps; // the intermediate results

// fanOut: 1→N, bounded concurrency, results in task order
const { results, usage } = await fanOut({ agent: scout, tasks, concurrency: 2 });
usage.busyMs / usage.wallMs; // the parallelism actually achieved
```

They all accept the same options:
`{ lifetime, signal, onEvent, bus, cwd, sessionDir, spawn }`.

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

## Examples

Directly executable, one per shape:

```bash
node examples/01-run.ts       # disposable
node examples/02-chain.ts     # the same chain in "task", then in "workflow"
node examples/03-fan-out.ts   # 3 tasks, 2 at a time
```

Not every provider reports tokens - several return zero. For the usage lines to
mean anything, pick one that does:

```bash
PI_SUBAGENT_MODEL=local/qwen/qwen3-coder-next node examples/03-fan-out.ts
```

## Status

This first batch ships the foundation - `Agent`, `Subagent`, `Result`, `Usage`,
the event bus - and two combinators, `chain` and `fanOut`.

Still to come: `loop`, `orchestrate`, `route`, `reduce`, session export
(`runs/<timestamp>/`), the herdr and TUI reporters, and the pi extension.
