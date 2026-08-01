# Examples

One script per shape, directly executable. No build step.

```bash
node examples/01-run.ts          # disposable: spawn, ask, close
node examples/02-chain.ts        # the same chain in "task", then in "workflow"
node examples/03-fan-out.ts      # 3 tasks, 2 at a time
node examples/04-loop.ts         # coding and review, as a team then with fresh eyes
node examples/05-herdr.ts        # a fan-out with one herdr split per branch
node examples/06-export.ts       # a fan-out exported to runs/<timestamp>/
node examples/07-reduce.ts       # 3 scouts, then one synthesiser: N to 1
node examples/08-route.ts        # a classifier sends two tasks to two agents
node examples/09-orchestrate.ts  # the planner decides the split, then it runs
node examples/10-interview.ts    # the interview, in a plain terminal
node examples/11-build.ts        # the pipeline on a throwaway repository
node examples/12-experiment.ts   # the same loop on several models, twice each
```

`11-build.ts` writes code. It runs on a throwaway repository it creates itself,
and nothing else.

## Choosing a model

The examples take `--model` on the command line - an argument, never an
environment variable, because ambient state reaching a subagent is the exact
hole this library plugs. Not every provider reports tokens, and several return
zeros at the source, so pick one that does if the usage lines are meant to mean
anything:

```bash
node examples/03-fan-out.ts --model local/qwen/qwen3-coder-next
```

See [Measurements](measurements.md) for why a zero is printed rather than
estimated. `12-experiment.ts` takes its models as plain arguments instead: it
runs one per model, which is what an [experiment](experiments.md) is.

## Watching them work

```bash
COMBO_HERDR=all node examples/03-fan-out.ts
```

Inside [herdr](https://herdr.dev), that gives every subagent its own split. See
[Display](display.md).

## A note on what an example may do

An example must not be able to rewrite the repository it ships in. Anything that
must not write does not get `write` and `edit` - it is not merely asked to
behave. A prompt is not a permission boundary; the toolset is.
