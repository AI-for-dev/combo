# Lifetime

A subagent is a session. Keeping it open keeps a context, a memory, and a token
cost that accumulates. Closing it starts clean but amnesic. Both are legitimate,
which is why the choice is **explicit and local** and never inferred.

| `lifetime` | The subagent | Cost and context | When |
| --- | --- | --- | --- |
| `"task"` *(default)* | is born and dies with each task | minimal context, reproducible | exploration, fan-out, independent tasks |
| `"workflow"` | lives for the workflow | remembers iterations, context grows | coding/review loop, iterative refinement |
| `"session"` | lives as long as the pi session | long memory, watch it | a companion agent consulted several times |

Resolution order, always: the explicit argument, then the agent's frontmatter,
then `"task"`. Persistence is asked for. It is never obtained by accident.

The order holds inside a workflow too, and it is decided agent by agent. In a
`loop` that names no lifetime, the shipped `coder` and `reviewer` both declare
`lifetime: workflow`, so each keeps one subagent for the whole loop, while a
`task` agent beside them gets a fresh one every turn. Two places set the
lifetime themselves: `run` forces `"task"`, and a flow node runs as `"task"`
unless its `memory:` names a scope, whatever the frontmatter says.

## The two regimes, on one workflow

Same code, one parameter, two different behaviours.

```typescript
// "Team": the coder and the reviewer remember the previous turns. The reviewer
// does not repeat its remarks, the coder knows what it was told.
await loop({
	steps: [coder, reviewer],
	input: task,
	lifetime: "workflow",
	until: (step) => saysWord(step.output, "LGTM"),
	maxIterations: 5,
});

// "Fresh eyes": brand new subagents at every iteration. No accumulated bias,
// every review starts from the code alone. More expensive in re-reading, more
// honest about the result.
await loop({ steps: [coder, reviewer], input: task, lifetime: "task" });
```

Neither is better. `"workflow"` converges faster and drifts; `"task"` costs more
and cannot fool itself.

## The rules

- **Whoever opens, closes.** The owner of a `Subagent` is whoever `spawn()`ed it.
  A workflow closes what it created in a `finally`, cancellation included, and
  **never** closes a live subagent it merely received.
- **Persistent subagents do not share their history.** "Working together" means
  passing `Result`s along, not merging contexts. If an agent must know what
  another one did, you tell it in the task.
- **No shared mutable state between fan-out branches**, whatever the lifetime.
  In `"workflow"`, each branch gets its own persistent subagent.
- **Context growth is visible.** `subagent.usage.contextTokens` is reported to
  the display. A `"workflow"` agent approaching its limit must either compact or
  fail cleanly, never truncate silently.
- **Lifetime does not change the shape of every combinator.** `reduce` is one
  agent and one turn, so `"task"` and `"workflow"` both spawn once. What differs
  is only what is observable.

## Closing, and what it triggers

```typescript
const coder = await spawn(coderAgent, { lifetime: "workflow", exportDir: dir });
try {
	await coder.ask("Implement the parser");
} finally {
	await coder.close();   // exports first, disposes after
}
```

`close()` writes the transcript before releasing the session, so the `finally`
of a workflow is already the "export what was done" path, interruptions
included. See [Export](export.md).

## Who opens and closes inside a combinator

No combinator spawns or closes anything itself. Each one plays its turns
through a `SubagentPool` built from the options it was handed, and the rule
above lives there, in one place. The lifetime is the workflow's when it names
one, otherwise each agent's own:

- `"task"`: a fresh subagent per turn, closed as soon as the turn is over.
- anything else: one subagent per `key`, reused, closed by `closeAll()`.

`key` is who shares a memory, and it defaults to the agent's name. A chain keys
by name, so in `"workflow"` the reviewer of the third step is the one that
reviewed the first. A fan-out keys by branch, because two branches must never
share a context.

```typescript
const pool = new SubagentPool(options);
try {
	const plan = await pool.turn(planner, task);
	return await pool.turn(coder, plan.output);
} finally {
	await pool.closeAll();     // whoever opens, closes - cancellation included
}
```

A turn asked for after the signal was aborted spawns nothing. It comes back as
a failed `Result` and is recorded anyway, so a workflow that was called off
says so where its answer would have been.

### A held subagent outlives the turn

`pool.hold()` is for a conversation rather than a task: it hands back an `id`
and an `ask`, and what it holds lives until `closeAll()` **whatever the
lifetime**. `interview` holds its interviewer, `swarm` holds its members. An
interviewer that forgot the previous question, or a member renamed at every
round, would not be a conversation.

That is the one case where `"task"` does not mean one subagent per turn, and
the caller asked for it by calling `hold` instead of `turn`.

`closeAll()` ends the subagents, not the record: what their turns produced is
on the pool's `trail`, which is read after the closing and not before. Writing
a combinator of your own is [Workflows](workflows.md#writing-one-in-typescript).

## Stopping is not closing

`subagent.stop()` cuts the turn in flight short and makes every later `ask`
fail at once with `"stopped"`. It changes nothing about ownership: the session
is still there, still exportable, and still owed the `close()` its opener
promised it. A stopped subagent inside a workflow is therefore closed by the
same `finally` as any other.

A whole run has a `signal` for that, but a signal cannot single one branch out -
it is shared, and a combinator hands out no handles. `stopSwitch` is the pair
that can: give the workflow its `signal` and its `spawn`, and stop what you like
from outside.

```typescript
const stop = stopSwitch({ signal: ctx.signal });
const running = fanOut({ agent: scout, tasks, spawn: stop.spawn, signal: stop.signal });

stop.one("scout#2");   // that branch fails with "stopped", the others carry on
stop.all();            // the turns in flight, and the ones not started yet
```

This is what `esc`, `ctrl+del` and `/stop` are wired to in the pi extension -
see [Display](display.md#stopping-what-you-are-watching).

## Reference

- [`subagent`](../reference/api/subagent.md) - `spawn`, `Subagent`, `SpawnOptions`.
- [`run`](../reference/api/run.md) - the disposable form, where the lifetime is forced to `"task"`.
- [`stop`](../reference/api/stop.md) - `stopSwitch`, the run's two halves.
- [`agent`](../reference/api/agent.md) - `Lifetime`.
- [`workflows/pool`](../reference/api/workflows/pool.md) - `SubagentPool`, `turn`, `hold`, `closeAll`.
- [`workflows/trail`](../reference/api/workflows/trail.md) - `Trail`, what the turns add up to.
