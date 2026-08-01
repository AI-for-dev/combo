# Experiments

One workflow, M models, N repetitions, one table. This is the layer the
[`model` knob](workflows.md) exists for: comparing models on the same work
requires the model to be an argument, and comparing them honestly requires the
run to be repeated.

```typescript
import { experiment, experimentTable, loop } from "combo";

const report = await experiment({
	models: ["anthropic/claude-sonnet-5", "local/qwen/qwen3-coder-next"],
	repetitions: 3,
	run: async (cell) => {
		const result = await loop({ ...cell.options, steps: [coder, reviewer], input, until: lgtm });
		return { ok: result.ok, converged: result.converged, iterations: result.iterations };
	},
});

console.log(experimentTable(report).join("\n"));
```

```
| model | runs | ok | converged | iterations | usage | mean wall | mean $ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-sonnet-5 | 3 | 3/3 | 3/3 | 1×2 2×1 | 8 turns 74.1s ↑121k ↓9.4k $0.4127 | 24.7s | $0.1376 |
| local/qwen/qwen3-coder-next | 3 | 3/3 | 1/3 | 3×3 | 18 turns 402.6s ↑340k ↓22k $0.0000 | 134.2s | $0.0000 |
```

## An experiment is a function, not a combinator

It returns no `Result` and composes with nothing. It is a harness placed *above*
a workflow, and one that could be nested inside a workflow would be measuring
itself. Everything else in this library is a combinator precisely because it can
be nested; this one is deliberately not.

Which also means a pipeline needs no special support - `PipelineRunOptions`
extends `WorkflowOptions`, so a cell runs one the same way:

```typescript
run: (cell) => runPipeline({ ...cell.options, pipeline, agents, input, verify }),
```

## The contract: spread `cell.options`

```typescript
type ExperimentCell = {
	model: string;        // this cell's model
	repetition: number;   // 1-based, matches rep-<n>/ on disk
	dir: string;          // this cell's directory, absolute, already created
	options: WorkflowOptions;
};
```

`cell.options` carries the cell's `model` and `exportDir`, the experiment's
`signal`, `timeoutMs`, `cwd` and `spawn`, and an `onEvent` combining the cell's
private collector with your own listener. **Spreading it is the contract**: a
callback that rebuilds those by hand puts its subagents on the wrong model, in
the wrong directory, and measures nothing.

What the callback returns becomes the table's columns:

```typescript
type ExperimentOutcome = { ok: boolean; error?: string }
	& Record<string, string | number | boolean | undefined>;
```

Flag columns are the union of the outcome keys actually seen - `converged`,
`approved`, `rounds`, whatever this study compares - so there is nothing to
configure. `ok` has its own column and `error` never becomes one: a column of
distinct sentences compares nothing.

## On disk

```
runs/2026-08-01_10-24-03/
├── experiment.json                machine-readable, every cell
├── experiment.md                  the table, plus the failures named under it
├── anthropic-claude-sonnet-5/
│   ├── rep-1/                     pi's transcripts per subagent + usage.json
│   └── rep-2/
└── local-qwen-qwen3-coder-next/
    └── …
```

Each cell writes the same [`usage.json`](export.md) a single run writes, from
its own collector. Measurement is reused, never reinvented.

## The rules

- **Sequential by default.** `concurrency` defaults to 1: two cells racing for
  the same machine measure the contention, not the models. Raise it when the
  providers are remote and the wall time matters more than the precision.
- **Model-major order.** Every repetition of the first model, then the second -
  so a matrix interrupted halfway holds finished models rather than a fragment
  of each.
- **A failed cell stays in the report**, with its usage: it spent tokens before
  it broke, and dropping it would quietly turn "two models out of three
  answered" into a clean comparison of the survivors. A callback that *throws*
  is a failed cell too, not a crashed experiment.
- **Sums are stored, means are displayed.** `experiment.json` carries totals;
  the mean wall and mean cost are computed when the table is rendered, never
  written down. Averaging averages is how a study starts lying about itself.
- **An abort stops launching new cells** and the partial report is still
  written, with `error: "aborted"` at the top.

## Running one

```bash
node examples/12-experiment.ts <modelA> <modelB>
```

Two repetitions of the same loop per model, the table printed at the end. Several
providers report no cost, and some report no tokens either - see
[Measurements](measurements.md) - so a `$0.0000` column means "not reported",
never "free". Give the matrix a `timeoutMs` it can live with: a cell lost to a
turn that would not end is a cell missing from the comparison.

## Reference

- [`experiment`](api/experiment.md) - `experiment`, `ExperimentCell`, `ExperimentOptions`.
- [`experiment-report`](api/experiment-report.md) - the report, the table, the writes.
