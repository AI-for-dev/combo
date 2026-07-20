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
  report them, the field is `0` and we say so. Verified: `local/*` reports
  tokens, `opencode-go/*` and `ilaas/*` do not.

## Reading it

```typescript
import { formatUsage, sumUsage } from "pi-subagent";

formatUsage(result.usage);
// 3 turns 12.4s ↑12k ↓2.1k R8k $0.0412 ctx:34k
```

`sumUsage` folds several together, which is how a workflow reports its total.

## Reference

- [`usage`](api/usage.md) - `Usage`, `deltaUsage`, `sumUsage`, `formatUsage`, `compact`.
- [`export`](api/export.md) - `usageReport`, the `usage.json` document.
