# Workflows

A workflow is a function from an input to a `Result` or a list of them. They
compose because they share that contract, and for no other reason. Agents are
data; workflows are code. There is no YAML DSL.

```typescript
type Result = {
	agent: string;
	output: string;        // last assistant text - what feeds the next step
	messages: AgentMessage[];
	usage: Usage;          // this turn only
	ok: boolean;
	error?: string;
};
```

Every combinator is an exported function. No classes, no inheritance, no global
registry.

## The nine

### `chain` - 1 to 1 to 1

The output of step *n* is the input of step *n+1*.

```typescript
const result = await chain({ steps: [scout, reviewer], input: "…" });
result.steps;   // the intermediate results
```

A failing step stops the chain: there is no input left for the next one.

### `fanOut` - 1 to N

N subtasks in parallel, with bounded concurrency.

```typescript
const { results, usage } = await fanOut({ agent: scout, tasks, concurrency: 2 });
usage.busyMs / usage.wallMs;   // the parallelism actually achieved
```

Results come back **in the order of `tasks`**, not of completion. A failing
branch becomes a `Result` with `ok: false` in its slot and the others carry on,
unless `failFast` is set.

### `loop` - 1 to 1, until a bar is reached

```typescript
const review = await loop({
	steps: [coder, reviewer],
	input: "Implement the parser",
	until: (step) => step.output.includes("LGTM"),
	maxIterations: 5,       // defaults to 5
	lifetime: "workflow",
});
review.converged;           // did it reach the bar, or run out of iterations?
```

**Reaching a cap is not success.** `ok` says the last turn ran without a model
error; `converged` says the work reached the bar. A loop that burns through
`maxIterations` with every turn technically fine is `ok: true, converged: false`,
and collapsing the two would hide the only thing worth knowing.

### `reduce` - N to 1

One agent turns a fan-out's branches into a single answer.

```typescript
const answer = await reduce({ agent: synthesiser, results, input: question });
answer.steps;   // the branches, then the synthesis
```

**Failed branches are shown, not dropped.** A synthesis of six reports when two
crashed, with nothing saying so, is a confident lie, and the caller can no longer
tell a thin answer from thin evidence. Pass only the successes if that is what
you want; filtering an array needs no option.

`reduce` returns the branches in `steps` followed by the synthesis, because the
cost of an N to 1 is the cost of everything that produced it.

### `route` - a classifier picks the destination

```typescript
const handled = await route({ router, destinations: [coder, scout], input: task });
handled.destination?.name;   // who was picked, or undefined
```

### `orchestrate` - an agent decides the split

```typescript
const done = await orchestrate({
	planner,
	workers: [scout, reviewer],
	input: "Explain how usage is measured, and whether it can be trusted",
	reduceWith: synthesiser,   // optional: one answer instead of N
	maxTasks: 3,               // defaults to 8
});
done.plan;     // validated against the known agents, before anything spawns
done.answer;   // present only when reduceWith was given
```

### `pair` - worker and reviewer, until accepted

```typescript
const built = await pair({ worker: coder, reviewer, input: task, maxRounds: 3 });
built.approved;   // distinct from ok
```

### `interview` - the agent questions the user

```typescript
const { brief, answers } = await interview({ agent: interviewer, input: request, ask });
```

See [Deliver a change](build.md).

### `deliver` - brief in, audited work out

Plan, a pair per subtask, the project's own check, an audit, fixes. See
[Deliver a change](build.md).

## Writing one in Markdown

A linear sequence of these combinators can be written as a file rather than as
code, and run by `/build`. See [Pipelines](pipelines.md). Anything that needs a
branch or a condition stays TypeScript, deliberately.

## What they all accept

```typescript
{ lifetime, signal, timeoutMs, openInHerdr, model, onEvent, bus, cwd, sessionDir, exportDir, spawn }
```

Same names, same defaults everywhere, plus whatever is specific to each one
(`concurrency` and `failFast` for `fanOut`, `until` and `maxIterations` for
`loop`, and so on).

`spawn` is an **injectable parameter**, never a hard import inside a combinator.
That is what lets every workflow be tested without a network.

`model` puts **every** subagent of the workflow on one model, whatever their
frontmatter says. It is an override, not a default, and that is the point: it
lets the same workflow run against different LLMs without editing an agent
file, and a pinned agent slipping through a sweep would make the comparison
measure a mixture.

```typescript
await loop({ steps: [coder, reviewer], input, model: "anthropic/claude-sonnet-5" });
```

## Deadlines

`timeoutMs` is a **per-turn** deadline, and it has **no default**.

One `ask` is one `session.prompt()`, and pi's agent loop is a `while (true)` with
no step cap: it runs as long as the model keeps requesting tools. A weak model
that hallucinates a tool name, gets "unknown tool" back and asks again will loop
until something stops it. Observed in the wild: 79 calls to a non-existent tool,
around 500k input tokens, in a single turn.

```typescript
await coder.ask(task, { timeoutMs: 120_000 });
await fanOut({ agent: scout, tasks, timeoutMs: 60_000 });   // per branch
```

There is no default because the library does not get to decide that a legitimate
task took too long. Set one on anything unattended.

`loop`'s `maxIterations` *does* default to 5, and that is not inconsistent: an
iteration is a discrete, expensive unit with a meaningful small default, whereas
any wall-clock default would be arbitrary. The two guards sit at different
levels, and "loop forever" must not be reachable by forgetting an argument.

## Failures and cancellation

- A failure does not crash a workflow. It becomes a `Result` with `ok: false`,
  and the caller - or an explicit `failFast` - decides whether to stop.
- A subagent that crashed after 12k tokens **cost** 12k tokens: its `Usage` is
  filled in even when `ok` is false.
- Cancellation propagates. The `AbortSignal` reaches every turn and closes the
  sessions that were opened.

## How a deciding agent is read

`orchestrate` and `route` put a model in charge of a decision, and both read its
answer with a **parsed convention** rather than a tool call or structured output:
the weak models this library is run against do not reliably emit tool calls, and
structured output is not uniformly available across providers.

The parsers are lenient about shape and strict about content:

- an unrecognised agent name is **dropped**, never remapped onto a plausible
  neighbour;
- an ambiguous routing answer resolves to **nothing** rather than to the first
  match;
- `orchestrate` validates the whole plan **before** spawning anything, and fails
  if it exceeds `maxTasks`.

Leniency was decided by real runs, not by taste. Asked for a JSON array, a
planner answered with bare objects and no brackets, and a green suite had said
nothing about it. The parser now accepts an array, a lone object, several objects
on their own lines, or a fenced block, and reduces them all to the same plan.

Independence cannot be enforced, only asked for. When work is genuinely
sequential, use `chain`.

## Reference

- [`workflows/chain`](api/workflows/chain.md), [`fan-out`](api/workflows/fan-out.md), [`loop`](api/workflows/loop.md), [`reduce`](api/workflows/reduce.md)
- [`workflows/route`](api/workflows/route.md), [`orchestrate`](api/workflows/orchestrate.md), [`plan`](api/workflows/plan.md)
- [`workflows/pair`](api/workflows/pair.md), [`interview`](api/workflows/interview.md), [`deliver`](api/workflows/deliver.md)
- [`workflows/common`](api/workflows/common.md) - `WorkflowOptions`, `SubagentPool`, `mapConcurrent`.
