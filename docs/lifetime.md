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
	until: (step) => step.output.includes("LGTM"),
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

## Reference

- [`subagent`](api/subagent.md) - `spawn`, `Subagent`, `SpawnOptions`.
- [`run`](api/run.md) - the disposable form, where the lifetime is forced to `"task"`.
- [`agent`](api/agent.md) - `Lifetime`.
