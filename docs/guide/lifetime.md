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
