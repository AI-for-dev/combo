# Measurements

Nothing is estimated and nothing is recomputed by hand. pi already reports tokens
and cost; the library **collects and attributes** them, and adds the one thing pi
does not measure - time - plus aggregation per subagent.

```typescript
type Usage = {
	// time, measured here on a monotonic clock
	wallMs: number;        // spawn to close, waiting included
	busyMs: number;        // time actually spent working: the sum of the asks
	turns: number;

	// tokens and cost, reported by pi, never reconstructed
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
};
```

```typescript
subagent.usage;   // cumulative since spawn
result.usage;     // this turn only
```

## Where the numbers come from

- `session.getSessionStats()` is the source of truth for tokens and cost.
- `session.getContextUsage()` gives context occupancy, worth showing for a
  persistent agent.
- Time is measured around each turn: `busyMs` is the sum of the `ask` calls,
  `wallMs` runs from spawn to close.

On a `"task"` subagent the two times are nearly equal. On a `"workflow"` one, the
**gap between them is the information**: waiting versus useful work.

## The rules

- **`getSessionStats()` is cumulative over the session.** A turn's usage is
  therefore the *difference* between two snapshots, taken before and after the
  turn. That is what gives both a cumulative `subagent.usage` and a per-turn
  `result.usage` without ever recounting a token.
- **Counters are clamped at zero.** Compaction can walk the totals backwards, and
  a negative usage means nothing.
- **A fan-out aggregates, it does not average**: total tokens, total cost,
  `wallMs` is the duration of the fan-out, `busyMs` the sum of the branches. The
  ratio of the two is the real parallelism, and that is what is worth seeing.
- **A failure counts.** A subagent that crashed after 12k tokens cost 12k tokens.
  Its `Usage` is filled in even when `ok` is false.
- **Never estimate tokens by counting characters.** If the provider does not
  report them, the field is `0` and we say so - and what a provider reports
  changes under you: one measured here reported no tokens at all, reports them
  today, and still reports no cost. So `$0.0000` means "not reported", never
  "free".
- **`input` counts every request, not every turn.** pi sends the whole prompt on
  each round trip, so one turn of a hundred tool calls sends a 14k context a
  hundred times and the counter reads millions. That number is right; the turn
  is the problem, and `timeoutMs` is what ends it.

## Reading it

```typescript
import { formatUsage, sumUsage } from "combo";

formatUsage(result.usage);
// 3 turns 12.4s ↑12k ↓2.1k R8k $0.0412 ctx:34k
```

`sumUsage` folds several together, which is how a workflow reports its total.

## A delegated run is a tree

A subagent that spawns children of its own is still one subagent among others:
it has its own `Usage`, and so does each child. What links them is the id of
whoever asked, carried on the `spawn` event and kept on the snapshot:

```
✓ explorer#1      1 turn 2.1s ↑8.0k ↓412 $0.0180
✓   scout#1       1 turn 9.4s ↑14k ↓1.1k $0.0402
✓   scout#2       1 turn 8.8s ↑13k ↓980 $0.0377
total            3 turns 20.3s ↑35k ↓2.5k $0.0959
```

Two things this is built around:

- **The total is the tree, never the root.** An explorer whose own turn cost
  eighteen cents while its scouts cost eighty is a cheap agent and an expensive
  run. `summaryTable` and `usage.json` both sum every row.
- **The link is an id, never a name.** Two explorers running at once share a
  name; nothing infers a parent afterwards, and a child whose parent is not in
  the list reads as a root rather than disappearing from the total.

The link reaches a tool through `SpawnOptions.customTools` in its function form:
the id is minted by `spawn`, so a tool that will spawn children is built from it
rather than before it.

```typescript
customTools: (parentId) => [delegateTool({ agents, holder: explorer, parentId })],
```

Comparing these numbers across models, over repeated runs, is what
[Experiments](experiments.md) is for - same collection, one table.

## Reference

- [`usage`](../reference/api/usage.md) - `Usage`, `deltaUsage`, `sumUsage`, `formatUsage`, `compact`.
- [`export`](../reference/api/export.md) - `usageReport`, the `usage.json` document.
