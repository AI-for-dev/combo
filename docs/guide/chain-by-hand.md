# Walk a chain by hand

`explorer → planner → coder → reviewer`, one command at a time, with you
deciding between two steps what happens next - which agent, on which model, from
which output.

```
/step explore     how usage is measured
/step planner     three steps at most, no refactor
/step coder
/step reviewer    is anything missing
/quote                                     # only now does this session read it
```

A chain a [flow](flows.md) could hold, with one difference: our code does not
walk it, you do. That buys you the join between two steps - reading the
plan before the coder sees it, running the reviewer twice, dropping a step that
went nowhere - at the cost of typing each one.

## Why it is not `/run`

`/run` puts its answer **in the conversation**, deliberately: an exploration is
read and then asked about, and a report you have to send back yourself before
the model knows anything about it is a report in the wrong place.

That is the wrong default for a chain you are walking. pi hands a custom message
to the model as a *user* message, so the session reads the explorer's report and
acts on it: it becomes an orchestrator, and every later step is chosen against
what it has already concluded. When the main window is meant to be a console,
whatever reaches it changes an answer you did not want changed.

So `/step` does the opposite on that one point, and nothing else:

| | `/run <flow>` | `/step <flow\|agent>` |
| --- | --- | --- |
| Runs | a flow, end to end | one stage, and stops |
| The answer | in the conversation | drawn in the transcript, **not** in context |
| The next step | the model's to suggest | yours to type |
| Carried output | between the flow's nodes | between your commands, in the relay |

## The commands

| Command | What it does |
| --- | --- |
| `/step <name> <instruction>` | Runs one flow or agent on the previous step's output plus what you typed. |
| `/step --from <id>` | Carry that step instead of the last one. `--from none` starts from scratch. |
| `/step --model <pattern>` | This step only. Plan on a large model, code on a small one. |
| `/step --agent <name>` | When a flow and an agent share a name, run the agent. |
| `/chain` | The steps walked so far, what each carried, and where they exported. |
| `/chain reset` | Drop it. The next `/step` starts a new chain, in a new folder. |
| `/quote [id]` | Put one step into this conversation, attributed. Default: the last. |

`<name>` is resolved against the flows first, then the agents - a stage of a
chain is often a whole flow, `explore` being a fan-out and a synthesis. A name
held by both runs the flow and says so; `--agent` runs the other one. A flow
is checked whole and held to this terminal before anything is spawned, as
`/run` holds it, and a broken flow file is refused rather than fallen past to
an agent of the same name.

A flow stage runs in the step's folder, which is its [run
directory](flows.md#the-run-directory): the snapshot, the journal and the
transcripts. A flow stage that stops says where, and what `/run resume` would
do with it: `step: explore failed at <visit>: <why> - the chain is unchanged,
/run resume <folder> picks it up at <visit>`.

`/run resume <that folder>` carries it on, and its answer lands in the
conversation as any `/run`'s does; the chain does not learn it. `/run resume`
alone looks only at the runs directly under `runs/`, so a step's run is
named by its path.

## What a step is handed

The first step gets your instruction, verbatim. Every later one gets two
sections, what you typed and what it carries:

```markdown
## Request

three steps at most, no refactor

## Output of step `explore`

Usage is collected in src/usage.ts:40 …
```

A flow stage reads that text as its `input`. When a chain is worth keeping,
write it down as a [flow](flows.md), and `/run` it or `/step` it.

An instruction is optional once something is carried: `/step reviewer` on its own
means "review that". With nothing carried and nothing typed, the step is refused
rather than sent to answer about nothing.

## What it leaves behind

One `runs/<timestamp>/` for the chain, one subfolder per step -
`1-explore/`, `2-planner/` - each with that step's transcripts and its
`usage.json`, exactly as [a run exports one](export.md). `/chain` names the
folder and totals the turns.

`/swarm` is a step too, of kind `swarm`: several copies of one agent on one
goal, recorded like any other so `/chain`, `/quote` and `--from` reach it. See
[Swarms](swarm.md).

A step that **fails** leaves the chain untouched. It produced nothing to carry,
and recording it would hand the next agent an error message as its input; what
ran is still on disk, and the same command can be retried on another model.

## What the session does not know

Nothing a step produces reaches the model until `/quote`. That is the point, and
it has a consequence: ask the session about the work and it will answer from a
conversation where none of it happened.

The screen has to carry that, because the next command is typed on a belief
about it. A finished step is drawn with its own header and its body indented
under it:

```text
◇ scout agent  1 turn  outside this conversation - /quote puts it in
  The ledger records obligations, which are "things that must happen before
  the work is finished" (src/review/ledger.ts:31).
  …
```

Looked at in a real pi, the first version of that header said the same thing in
the same muted grey as the turn count, above a report drawn flush left at full
width - which is exactly how an answer the session gave is drawn. The phrase
carries the theme's warning colour now, and the indent makes the block read as
an aside before a word of it is read.

`/quote` is the way out, one step at a time. It arrives attributed -
``Result of the `planner` step of the chain, asked to: …`` - because an
unattributed report in a user slot reads as an instruction.

Subagents never had this problem: one **never** inherits the parent session's
context, walked by hand or not ([Agents](agents.md)). The relay is the only
thing that crosses from one step to the next, and it carries a `Result`, not a
conversation.
