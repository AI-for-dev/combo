# Workflows

A workflow is a function from an input to a `Result` or a list of them. They
compose because they share that contract, and for no other reason. Agents and
flows are data; our code decides what runs next. A workflow is the TypeScript
for what a [flow](flows.md) file cannot say.

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

Every combinator returns a `WorkflowResult`: that `Result`, read for the whole
workflow, plus `steps`, the trail that led to it. The reading is the
combinator's own and is decided nowhere else. A chain is its last step and a
reduce its synthesis; a fan-out is its branches labelled one after the other,
failed if any of them failed; an orchestration is its synthesis when it has
one and its planner otherwise. What a workflow says beyond that - `converged`,
`plan`, `answers` - it says in fields of its own, because `ok` only ever means
that every turn ran. A caller or a tool call therefore reads any of them the
same way, and never has to rebuild one.

Every combinator is an exported function. No classes, no inheritance, no global
registry.

## The combinators, and two patterns that are not

There are eight combinators: `chain`, `fanOut`, `loop`, `reduce`, `route`,
`orchestrate`, `interview` and `swarm`. Two more sections cover patterns you
would look for here, and neither is a combinator: a reviewer until approval is
written as a flow, and a subagent with subagents is given a tool,
`delegateTool`.

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
unless `failFast` is set. As one `Result`, the fan-out's `output` is every
branch's under a heading naming its agent, a failed one marked with its error,
and its `ok` is false the moment one branch failed.

### `loop` - 1 to 1, until a bar is reached

```typescript
const review = await loop({
	steps: [coder, reviewer],
	input: "Implement the parser",
	until: (step) => saysWord(step.output, "LGTM"),
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

### A reviewer until approval, and a delivery

A coder and a reviewer talking until the reviewer approves, and a delivery
(plan, a pair per subtask, the project's check, an audit of the whole), are
written as a flow now: the `pair` and `deliver` loops of the shipped
[`build`](../reference/flows/build.md). The reviewer decides through the
`verdict` tool, what it raises is kept as obligations until it closes them,
and each subtask works in a copy of the repository. See [Flows](flows.md) and
[Deliver a change](build.md).

### `interview` - the agent questions the user

```typescript
const { brief, answers } = await interview({ agent: interviewer, input: request, ask });
```

See [Deliver a change](build.md).

### `swarm` - several members, one job, nobody dividing it

Every combinator above decides who does what. A swarm decides none of it: the
members are told the same goal, handed a board to talk on and a set of claims to
take work from, and what they divide between them is theirs.

```typescript
const done = await swarm({
	members: [{ agent: member, count: 3 }],
	goal: "describe every file under src/reporters/",
	claims: createClaims({ keys: files }),
	rounds: 2,
});
done.posts;    // the run's social history, in order
done.claims;   // what was held at the end, and what the swarm released
done.converged // whether `until` fired. Reaching the round cap is not success
```

A round is one `ask` per live member. A member whose turn fails drops out rather
than costing every remaining round, and keeps the turn that failed as its
answer. `lifetime` defaults to `"workflow"` here and nowhere else: a member that
forgets the last round cannot build on what it saw. For the same reason
`lifetime: "task"` with more than one round is refused outright - a member's id
is its name on the board, and a task-lifetime member gets a new one every round.

**With no board, no claims and one round, a swarm is a fan-out.** That is the
control arm: the board's worth is the difference between the two, measured, on
the job you actually have.

[Swarms](swarm.md) is the page on it: what a member is, what running one says,
and what a board does not do. Two things a run of it showed, both now built in. Members are *handed* what is
new on the board rather than made to fetch it, because once something
arbitrates they stop reading it altogether. And whatever a member still held is
released when it goes, because claims left by a member that has closed are work
nobody will do and nobody can take.

### A subagent with subagents

An agent whose `tools:` names `subagent` can delegate in turn. The tool is built
by the caller and handed over like any other:

```typescript
const answer = await run(explorer, question, {
	cwd: repo,
	customTools: (parentId) => [delegateTool({ agents, parentId, cwd: repo })],
});
```

`agents` is the roster it may name, and nothing else. It goes two levels deep by
default: the session, a child, a grandchild. At the bound the tool refuses and
says so, rather than being withheld and leaving a model calling something that
is not there.

`customTools` is written as a function here for one reason: `parentId` is the id
`spawn` is about to give this subagent, and passing it is what has the children
measured **under** it rather than beside it. See
[Measurements](measurements.md). A list still works, and a tool that spawns
nothing has no use for the id. A workflow that adds a tool of its own beside
whatever its caller offered composes the two with `offerBoth`, whichever shape
either was written in: that is how `swarm` hands every member the board.

`examples/14-delegation-tree.ts` is one explorer, three scouts and one answer,
and it prints what the tree cost.

## Writing one in Markdown

A task graph of agents, branches, loops and questions can be written as a
file rather than as code, and run by `/run`, `/step` and the `subagent` tool.
See [Flows](flows.md).

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

## Writing one in TypeScript

A combinator is a function over a `SubagentPool`. The pool takes the options
above and plays the turns; the combinator only says who speaks, in what order,
and what is done with the answer.

```typescript
export async function twice(options: WorkflowOptions & { agent: Agent; input: string }) {
	const pool = new SubagentPool(options);
	try {
		const first = await pool.turn(options.agent, options.input);
		if (!first.ok) return first;
		return await pool.turn(options.agent, `Do it again, better:\n${first.output}`);
	} finally {
		await pool.closeAll();
	}
}
```

`turn` is one question and one answer. It refuses without spawning when the
signal is already aborted, runs the turn with the workflow's `signal` and
`timeoutMs`, and gives the subagent back whatever happened - which in `"task"`
lifetime closes it. The `key` decides who shares a memory in a persistent
lifetime: it defaults to the agent's name, and a fan-out passes the branch
instead so two branches never meet.

`hold` is for a conversation: it hands back an `id` and an `ask` for several
turns in a row, and the subagent lives until `closeAll` whatever the lifetime.
`interview` holds its interviewer, `swarm` holds its members. A hold is refused
the way a turn is when the signal is already aborted: nothing is spawned, and
every `ask` of it answers `aborted`.

`pool.trail` is what the turns add up to: every turn played, refusals included,
in `steps`; their usage summed over the pool's own clock in `usage()`; the first
that failed in `broken()`. A combinator reports from there rather than keeping a
list and a clock of its own:

```typescript
	} finally {
		await pool.closeAll();
	}
	return { ...last, steps: pool.trail.steps, usage: pool.trail.usage() };
```

A workflow whose clock must start before its pool can exist, or that composes
other workflows and has no pool, opens a `Trail` itself and records on it: the
pool takes one as its second argument, and `record` hands back what it was
given so a step is recorded where it is made.

`closeAll` goes in a `finally`. Whoever opens, closes, cancellation included.

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

A turn cut by its deadline fails with `"timed out after 2m"`, one called off by
the caller's `signal` with `"aborted"`, and one a person stopped with
`"stopped"`. The bound reads the way a flow file writes a duration, and in
milliseconds when it is not whole seconds: `timeoutMs: 1_500` fails with
`"timed out after 1500ms"`. A flow's turn, question and check that run past
their bound say the same words.

A `signal` that aborts with a `TimeoutError` as its reason, as
`AbortSignal.timeout` does, counts as a deadline too: that is how a flow bounds
its attempts, and why its journal and its `usage.json` both read a timeout.

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

- [`workflows/chain`](../reference/api/workflows/chain.md), [`fan-out`](../reference/api/workflows/fan-out.md), [`loop`](../reference/api/workflows/loop.md), [`reduce`](../reference/api/workflows/reduce.md)
- [`workflows/route`](../reference/api/workflows/route.md), [`orchestrate`](../reference/api/workflows/orchestrate.md), [`plan`](../reference/api/workflows/plan.md)
- [`workflows/interview`](../reference/api/workflows/interview.md), [`swarm`](../reference/api/workflows/swarm.md)
- [`workflows/options`](../reference/api/workflows/options.md) - `WorkflowOptions`, what every combinator takes.
- [`workflows/pool`](../reference/api/workflows/pool.md) - `SubagentPool`, where a workflow's turns are played.
- [`workflows/trail`](../reference/api/workflows/trail.md) - `Trail`, what the turns add up to.
- [`workflows/concurrent`](../reference/api/workflows/concurrent.md) - `mapConcurrent`.
