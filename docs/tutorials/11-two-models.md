# Same work, two models

![Same work, two models](../_static/tutorials/11-two-models.svg)

"Which model should the coder run on" gets asked a lot, and most answers are
benchmarks nobody ran on their own code. The honest version is small: the same
workflow, on the same repository, on two models, with the bills side by side.
This page does that twice, once from the prompt line in thirty seconds and
once properly.

## The knob

Every subagent so far ran on the one model the pi that typed these pages was
started with, because nothing overrode it. That is the last resort in a chain of
overrides, and the chain is worth knowing because comparing models requires the
model to be an **argument**:

1. `--model` on `/run`, `/build` or `/step`, or `model` on the `subagent` tool.
   Every subagent of that call, whatever its file says.
2. `model:` at the top of a pipeline file.
3. `model:` in the agent's frontmatter.
4. pi's own settings.

Nearest wins. No environment variable is read anywhere: an ambient variable is
exactly how a run ends up on a model nobody named. Measured, in this
repository: a `/run explore` with no `--model` put all four subagents on a
model named nowhere in the tree, and nobody noticed until `usage.json` said so.
An experiment that left every level empty is measuring the operator, not the
models.

None of the shipped agents declares a `model:`, on purpose: a package that
pinned one would override your settings and fail outright for anyone without
a key for that provider. **A definition that ships leaves it open; a
measurement pins it.**

## The quick version

The two compared below, `provider/model-a` and `provider/model-b`, were both
small open-weight models of about the same size, served from the same endpoint.
Put two your pi can reach in their place: what this page shows is the shape of
the comparison, and the shape does not depend on which two.

You have already run the first half. Now the second:

```
/run --model <provider/model-b> explore how is the wall time of a subagent measured, and where
```

Two folders under `runs/`, two `usage.json`, one table:

| | provider/model-a | provider/model-b |
| --- | --- | --- |
| wall | 63.5s | 16.4s |
| busy | 98.8s | 31.8s |
| parallelism | 1.56 | 1.95 |
| input | 123.6k | 107.4k |
| output | 5.1k | 4.0k |
| tool calls, three scouts | 3 / 5 / 6 | 5 / 8 / 5 |
| cost | not reported | not reported |

Four times faster at the same size, a sixth fewer input tokens, more tool calls.
Both answers found the mechanism, the clock and the three places, and both got
every line number wrong. The second wrote `~line 149-154`, with a tilde,
hedging a number it had no way to know; the first wrote `line 163` with none.
Read the two synthesiser reports in the two folders and you know more about
these models on your code than a leaderboard can tell you.

One run each, though. The fast model may have been lucky, the slow one may have
hit a slow minute on a shared server. That is the limit of the quick version,
and it is why the proper one repeats.

## The proper version

`experiment` is a harness above a workflow: M models, N repetitions, one
directory per cell, one table. It returns no `Result` and composes with
nothing, deliberately, because a harness that could be nested inside a
workflow would be measuring itself.

```bash
node examples/12-experiment.ts <provider/model-a> <provider/model-b>
```

The example runs a coder and reviewer loop twice per model on this
repository, with the coder's tools cut down to read-only so that it describes
the change rather than making it, and prints the table:

```
| model | runs | ok | converged | iterations | usage | mean wall | mean $ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| provider/model-a | 2 | 2/2 | 2/2 | 1×2 | 4 turns 252.8s ↑255k ↓27k $0.0000 | 126.4s | $0.0000 |
| provider/model-b | 2 | 2/2 | 2/2 | 1×1 2×1 | 6 turns 23.8s ↑43k ↓2.9k $0.0000 | 11.9s | $0.0000 |
```

Both converged every time. One took ten times longer per cell and six times
the input tokens, and the other needed a second round once, which is the
column `1×1 2×1`: one run of one iteration, one run of two. Whether the slow
one's review was worth its price is in the transcripts under `runs/`, and is
the question you actually had.

Something else is in those transcripts. The coder was handed `read`, `grep`,
`find` and `ls`, and on the first cell it called `write` anyway. pi refused
the call, because the tool was not in the session, and the working tree was
untouched afterwards. The event stream recorded the attempt. That is the
[boundary from page five](05-an-agent-that-cannot-write.md), seen from the
other side, and it is why the coder's tools were cut down for an example that
runs on the repository it ships in.

Its shape is short enough to copy:

```typescript
import { experiment, experimentTable, loop, saysWord } from "@ai-for-dev/combo";

const report = await experiment({
	models: ["provider/model-a", "provider/model-b"],
	repetitions: 2,
	timeoutMs: 300_000,
	run: async (cell) => {
		const result = await loop({
			...cell.options,
			steps: [coder, reviewer],
			input: task,
			lifetime: "workflow",
			until: (step) => saysWord(step.output, "LGTM"),
			maxIterations: 3,
		});
		return { ok: result.ok, converged: result.converged, iterations: result.iterations };
	},
});

console.log(experimentTable(report).join("\n"));
```

**Spreading `cell.options` is the contract.** It carries the cell's model and
its export directory, the experiment's signal, deadline and `cwd`, and a
listener that records every event. A callback that rebuilds those by hand puts
its subagents on the wrong model in the wrong directory, and measures nothing.
Whatever the callback returns becomes the table's columns, so `converged` and
`iterations` are there because this callback said so and for no other reason.

The rules it keeps, each one a way a comparison learns to lie:

- **Sequential by default.** Two cells racing for one machine measure the
  contention. Raise `concurrency` when the providers are remote and you know
  what you are trading.
- **Model-major order.** Every repetition of the first model, then the second,
  so an interrupted matrix holds finished models rather than a fragment of
  each.
- **A failed cell stays in the report, with its usage.** Dropping it would turn
  "two models out of three answered" into a clean comparison of the survivors.
  A callback that throws is a failed cell, not a crashed experiment.
- **Sums are stored, means are displayed.** `experiment.json` carries totals;
  the mean column is computed when the table is drawn and never written down.
  Averaging averages is how a study starts lying about itself.
- **Every cell keeps its event stream**, `events.jsonl`, with no way to turn
  that off: a cell whose stream was not kept can only be re-run, and a matrix
  is expensive.

```
runs/2026-09-19_10-46-58/
├── experiment.json
├── experiment.md
├── provider-model-a/
│   ├── rep-1/    usage.json  events.jsonl  coder-1.jsonl  reviewer-1.jsonl …
│   └── rep-2/
└── provider-model-b/
    └── …
```

A pipeline needs no special support: `runPipeline({ ...cell.options, pipeline,
agents, input })` in the callback runs `explore` per cell, and the quick
version above becomes the proper one in four lines.

Every subagent in these eleven pages was placed by you, through a call, a file
or a flag. The last page is about the one that places its own.

**Next:** [A subagent that splits its own task](12-a-subagent-with-subagents.md).
