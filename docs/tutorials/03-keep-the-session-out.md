# Keep the session out of it

Here is a failure that is hard to see because it looks like competence. You
ask the session to have a scout find something, then a planner to plan from
it, then a coder to build the plan. Each report lands in the conversation, the
main model reads each one, and by the third step it is no longer relaying your
instructions: it is an orchestrator with a view of its own, and it phrases the
coder's task against a conclusion it drew from the scout's report two steps
ago. Nothing is wrong, exactly. You are no longer the one deciding.

`/step` runs one agent at a time and tells the session **nothing**. Every
result is drawn in the transcript for you to read, carried to the next step by
the extension, and kept out of the model's context until you put it there.

## Walk it

```
/step scout where is the wall time of a subagent measured
```

One dot, then the report appears in the transcript:

```
The wall time of a subagent is measured in src/subagent.ts by taking the
difference between the current time and the moment the subagent was spawned
using performance.now().

Specifically:
- src/subagent.ts:154: The spawn time is recorded: const spawnedAt = performance.now();.
- src/subagent.ts:178-181: The usage getter calculates the elapsed wall time on
  demand: wallMs: performance.now() - spawnedAt.
- src/subagent.ts:269: The final wall time is captured when the subagent is
  closed: const finalUsage = { ...usage, wallMs: performance.now() - spawnedAt };.

scout: 1 turn - /step <next> carries it on, /quote puts it in this conversation
```

Read the last line. It is the whole contract: the next step will be handed
this, and the conversation has not been.

```
/chain
```

```
1. scout  agent where is the wall time of a subagent me…  1 turn
1 step, 1 turn - exported to /…/combo/runs/2026-09-19_10-29-57
```

Now the second step, with no instruction beyond a question. It receives the
scout's report as its input:

```
/step reviewer is the measurement trustworthy
```

```
LGTM

reviewer: 1 turn - /step <next> carries it on, /quote puts it in this conversation
```

```
/chain
```

```
1. scout     agent where is the wall time of a subagent me…  1 turn
2. reviewer  agent ←scout is the measurement trustworthy  1 turn
2 steps, 2 turns - exported to /…/combo/runs/2026-09-19_10-29-57
```

The arrow says what the reviewer was handed. Both steps were exported into one
folder, a subfolder each, with their transcripts and their own `usage.json`.

## Read what happened before anything acts on it

Look at that `LGTM`. The reviewer was asked whether a measurement is
trustworthy, and answered with the one word its definition allows for
approval. It read a report rather than code, and a reviewer is written to
review code: handed a paragraph, it said the only thing it knows how to say.

Nothing acted on that. Had this been `/run` on a pipeline, the next step would
have been handed `LGTM` as its input and carried on. Here it is a line in the
transcript, and you are the join between the steps: you read it, you decide
the reviewer was asked the wrong thing, and you type a better step or none.
That join is what walking by hand buys, at the cost of typing each step.

Prove to yourself that the session knows none of it:

```
> what did the reviewer say?
```

It answers from a conversation in which no reviewer ran. The two steps are not
in its context, which is what you asked for.

## Let it in, one step at a time

```
/quote
```

```
◆ chain · scout → reviewer
Result of the reviewer step of the chain, asked to: is the measurement trustworthy.

LGTM

quote: reviewer is now in this conversation
```

Now it is in. `/quote` sends the last step by default, or `/quote 1` for the
scout, and it arrives **attributed**: pi hands the text to the model in a user
slot, and an unattributed report sitting in a user slot reads as an
instruction. The two lines of framing are what turn it back into a result of
something that ran.

## A different model per step

The step is where the model is chosen. A plan is worth a large model, the
coding it describes often is not, and a review is. `--model` on a step applies
to that step alone:

```
/step --model anthropic/claude-opus-5 planner three steps at most, no refactor
/step --model ilaas/qwen-3.6-35b-instruct coder
/step --model anthropic/claude-sonnet-5 reviewer
```

A step with no `--model` runs on the agent's own `model:` if it names one, and
on pi's settings if it does not. The model your session happens to be on is
never the default: a subagent running on whatever the operator's TUI is on is
the same hole one level up.

Two more flags, and then the command is learnt:

- `/step --from 1 coder` carries the scout's report instead of the last step.
  `--from none` starts from nothing.
- `/step --agent scout …` when a pipeline and an agent share a name. A `<name>`
  is resolved against the pipelines first, because a stage of a chain is often
  a whole pipeline: `/step explore …` runs three scouts and a synthesis as one
  step.

`/chain reset` drops the chain. The next `/step` starts a new one, in a new
folder.

## What a step is handed, byte for byte

Every step after the first receives two sections:

```markdown
## Request

is the measurement trustworthy

## Output of step `scout`

The wall time of a subagent is measured in src/subagent.ts …
```

Your instruction is the request, and what came before is labelled with the
step it came from. A step of a [pipeline](../guide/pipelines.md) receives the
same two sections under its own `## <id>` prose, through the same function.
A chain walked by hand and the same chain written down as a file send the
model the same bytes, so what you learn from one transfers to the other.

By the third time you have typed `scout`, then `planner`, then `coder`, the
chain exists. The next page writes it down.

**Next:** [Write the chain down](04-write-it-down.md).
