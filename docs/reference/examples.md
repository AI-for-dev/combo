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
node examples/11-build.ts        # the shipped build flow on a throwaway repository
node examples/12-experiment.ts   # the same loop on several models, twice each
node examples/13-concurrent-writers.ts  # two coders writing at once, a copy each
node examples/14-delegation-tree.ts     # one explorer, three scouts, one answer
node examples/15-swarm.ts               # three members, one board, nobody dividing it
node examples/16-debate.ts              # three debaters, one camp each, until they agree
```

`11-build.ts` and `13-concurrent-writers.ts` write code, and both refuse to run
anywhere but a throwaway repository you name. `11` needs a
`.pi/checks/test.sh` there, the script the flow's `tests` node runs. In `13`
each coder works in a copy, and only the patches come back, one at a time.
Neither commits.

## Choosing a model

The examples take `--model` on the command line - an argument, never an
environment variable, because ambient state reaching a subagent is the exact
hole this library plugs. Not every provider reports tokens, and several return
zeros at the source, so pick one that does if the usage lines are meant to mean
anything:

```bash
node examples/03-fan-out.ts --model local/qwen/qwen3-coder-next
```

See [Measurements](../guide/measurements.md) for why a zero is printed rather than
estimated. `12-experiment.ts` takes its models as plain arguments instead: it
runs one per model, which is what an [experiment](../guide/experiments.md) is.

## Keeping what a run did

`14-delegation-tree.ts` also takes `--export`, which writes every subagent's
transcript and a `usage.json` into `runs/<timestamp>/`:

```bash
node examples/14-delegation-tree.ts --model <provider/model> --export "how do the reporters differ?"
```

The flag takes no value, unlike `--model`: one that swallowed the word after it
would eat the first word of the question. The report carries the delegation -
each scout with the `parentId` of the explorer that asked for it, rows in tree
order, and a total that is the whole tree. See [Export](../guide/export.md).

## Comparing a swarm against not having one

`15-swarm.ts` takes two more flags, because a swarm is worth what it beats:
`--control` runs the same three members with no claims and one round, which is a
fan-out, and `--hold <n>` bounds how much one member may hold at once.

```bash
node examples/15-swarm.ts --model <provider/model> --control
```

See [Swarms](../guide/swarm.md) for what three arms of it came back with.

`16-debate.ts` is the swarm with nothing to divide: three `debater`s on one
question, each opening for the camp its brief names, until every latest vote
agrees. They post one vote a turn and answer each other's posts with `re`.
`--same` is its control, the same question with no camps. `--camps` and
`--rounds` change the rest, and `--members` sets the size of the control.

```bash
node examples/16-debate.ts --model <provider/model> --same
```

## Watching them work

`examples/05-herdr.ts` asks for a split per subagent with `openInHerdr: true`.
Inside [herdr](https://herdr.dev) that gives every branch its own pane, and
outside it the run is identical. See [Display](../guide/display.md).

## A note on what an example may do

An example must not be able to rewrite the repository it ships in. Anything that
must not write does not get `write` and `edit` - it is not merely asked to
behave. A prompt is not a permission boundary; the toolset is.
