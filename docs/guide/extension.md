# Extension

The extension exposes the library inside pi: a `subagent` tool the model can
call, rendered live in the TUI, plus the interactive commands.

```bash
pi -e extension          # this session only, the flag accepts a directory
pi install ./extension   # permanently, via settings
```

Every feature is usable from a script *before* it is exposed here. The extension
is a second surface over one core, never a place where logic lives.

## The tool

```
> use subagent to review src/usage.ts with coder then reviewer, looping until LGTM
> use subagent with three scouts and reduceWith "synthesiser" to explain the export path
> use subagent in orchestrate mode with planner and candidates scout, reviewer to audit the usage code
> use subagent with export true to explore the parser with three scouts
```

Agents come from `~/.pi/agent/agents/` by default. The demo agents of this
repository live in `.pi/agents/`, so ask for them explicitly:

```
> use subagent with scope "project" and agent "scout" to find the auth code
```

That is deliberate: project agents are repository-controlled content, so they are
never loaded by default. See [Agents](agents.md).

The tool also runs a [flow](flows.md) by name, with `task` as its input:

```
> use subagent to run the interview flow on "add a --verbose flag to scripts/drive-pi.py"
```

The model calls it with `flow: "interview"` and `task`, and the flow runs the
way `/run` runs it: checked against this terminal before anything is spawned,
in a `runs/<timestamp>/` of its own, its plan drawn above the prompt. Its
questions are put to you during the model's turn, on the same [question
card](#the-question-card). Somebody is there only in pi's terminal: in `pi
-p` or `pi --mode rpc`, which has no card to draw, a flow that could reach a
question with no `default:` and no `enough:` is refused before it starts, and
the others take their `default:` or `enough:`. Two calls in one message run
one after the other, so only one flow puts its cards up at a time. The model reads the output of the flow's last root node and the
line on how the run ended, which names the run directory; a run that stopped
says what `/run resume <run directory>` would do with it. The tool does not
resume.

`flow` takes `task`, `model`, `timeoutMs`, `scope` and `herdrAll` beside it,
and nothing else. A composition field given with it (`steps`, `until`,
`candidates`, `lifetime`…) is refused by name, since the file says what runs:

```
Error: subagent: `flow` runs a flow as its file describes it, and takes only `task`, `model`, `timeoutMs`, `scope`,
`herdrAll` beside it - drop `steps`, `until`
```

The flows come from the same places as the agents: the package's own and
`~/.pi/agent/flows/`, and `.pi/flows/` with `scope: "project"` or `"both"`.

`/interview` writes its transcript into a `runs/<timestamp>/` folder of its own.
That folder is made **before** the first question rather than after the last,
because a failed interview is the one moment "what was actually sent" is the
only question worth asking, and it used to leave nothing to read. The failure
names the folder.

The interview is watched like any other run: a row per subagent, with what
it is reading. Measured on this repository against a small open-weight model,
its first turn is 35 seconds and seven file reads, and the whole interview 57
seconds over three turns. Without the row that first turn is half a minute of a
status line that does not move, which is indistinguishable from a turn that has
hung.

**`--model` covers the interview too**, and `--questions` caps how many it asks.
The interviewer reads the repository between questions rather than asking what
it could find out, so a question is an exploration and not a round trip: six of
them on a slow model is minutes before the brief exists. Each turn
gets a five minute deadline, because pi's agent loop has no step cap and a
person waiting cannot tell a slow turn from a stuck one.

Flags come first, in any order, and a line may end on a `\` when the command is
too long for one: what follows the wrap is read like the rest of it. `/run`
also reads its two flags at the end of the line, where a flag in the middle of
the text stays text. That wrap
used to end the parse, which is how a `/swarm` written over two lines ran every
member on pi's own model - its `--model` had become the first two words of the
goal, and nothing said so.

`--agent` on `/step` takes no value, unlike `--model`: a flag that swallowed
the word after it would eat the first word of the request. Whether a flow's
workers get a copy of the repository is the file's to say, with `copies: true`
on a block; see [Worktrees](worktree.md) for what it costs and what it buys.

`until` is a **whole-line match**: the loop stops when the word stands alone on
one of the lines, whatever decoration the model put around it. A line with
anything else on it does not count, so a review that writes "I cannot say LGTM
yet" keeps the loop going. It reads through
[`saysWord`](../reference/api/text.md), which a workflow of your own can call.

The tool also takes `model`, which puts every subagent of the call on one model,
whatever their frontmatter says. **The parent session's model is never
inherited**: a subagent running on whatever the operator's TUI happens to be on
is the same bug one level up. The model comes from an explicit artifact - an
argument or a file - or pi's settings take over as the last resort.

## A subagent that splits further

A subagent spawned here can have subagents of its own, and **its own definition
decides**: an agent whose `tools:` names `subagent` is handed the tool, anybody
else is offered nothing. Nothing in the call turns it on, and nothing turns it
on for an agent that did not ask.

```
> use subagent with agent "explorer" to compare the four reporters
```

The roster a child may reach is the one this call loaded, so `scope` covers it
too. `maxDepth` is the bound, two by default: the session, a child, a
grandchild. At the bound the tool is still handed over and refuses when called,
because a model told "unknown tool" tries again, and that is the runaway turn
`timeoutMs` exists to survive.

The children run on the terms of the call - its model, its deadline, its export
directory, its signal - and they are **drawn under the subagent that asked for
them**, in the dots above the prompt and in both views of the finished call. A
run with no delegation looks exactly as it did.

What the run looks like while it happens is covered in [Display](display.md),
and what a tree costs in [Measurements](measurements.md).

## The commands

| Command | What it does |
| --- | --- |
| `/interview [--model <pattern>] [--questions <n>] <request>` | Turns a vague request into a brief, one question at a time. |
| `/run [--model <pattern>] [--timeout <duration>] <flow> <input>` | Runs a flow in a run directory of its own, drawn as it goes; its answer lands in the conversation. `/run build <request>` is the shipped build. |
| `/run resume [<run directory>]` | Carries on a run that stopped: the newest one here that can go on, or the one named. |
| `/run` | Lists the flows, as `/flows` does. |
| `/agents` | Lists the agents that can be spawned, grouped by where they came from. |
| `/flows` | Lists the flows, where each comes from, the most it can cost in turns and time, and its description. A refused file is listed beside them with its faults, in the warning colour, a file left in an old `pipelines/` directory included. |
| `/flows <name>` | Prints that flow's plan: every node, what it reads, its agent and file, its bound. |
| `/step [--from <id>] [--model <pattern>] [--agent] <name> <instruction>` | Runs one flow or agent on the previous step's output. Drawn, and kept out of this session's context. |
| `/swarm [--members <n>] [--claim a,b] [--hold <n>] [--until agree] [--rounds <n>] [--agent <name>] [--model <pattern>] <goal>` | Several copies of one agent on one job, with a board between them. Finished by coverage of what `--claim` names, or by `--until agree` when they all vote the same. Drawn as a step of the chain, like `/step`. |
| `/chain`, `/chain reset` | The steps walked so far; or drop them and start a new chain. |
| `/quote [id]` | Put one step of the chain into the conversation, attributed. |
| `/stop [<id>\|all]` | Stops the selected subagent, one named by id, or the whole run. `esc` and `ctrl+del` do the same from the keyboard. |
| `/herdr on\|off` | Give every subagent its own herdr split for this session. `on` asks herdr first, and says so when the answer is no. |

A question card is shown during a model's turn as well as during a command:
the `subagent` tool puts a flow's questions to you while the turn waits. `/run
build` asks nothing; see [Deliver a change](build.md).

`/flows` runs a flow's check and nothing else, so it spawns nothing and needs no
model: a typo in a flow costs a glance at the list. What the check cannot see,
the tree and the ports a run is launched with, is checked when a run starts.
See [Flows](flows.md#where-flows-live).

`/step` is the other way of running a flow: one stage per command, with this
session kept out of it until you say otherwise. A flow stage gets a run
directory of its own, the step's folder, which `/run resume <run directory>`
carries on. See [Walk a chain by hand](chain-by-hand.md).

**The extension brings its own agents and flows**, so it works the moment it
is loaded rather than only inside a repository where the definitions were copied
by hand. They sit at the **lowest priority**: a definition of the same name in
`~/.pi/agent/` replaces one of ours, and one in the repository replaces both.

That is safe for a reason worth stating plainly: loading an extension already
runs its code - pi's own documentation says so - so reading Markdown from the
same directory adds no risk that installing it did not already accept. What
matters is that it can never take a name away from you.

## Running a flow

`/run <flow> <input>` checks the flow whole, then holds it to this terminal:
the working directory, its question card, the project's scripts and git. A
fault at either stage is said before anything is spawned, one per line, `file
at: message`, so `/run build` outside a git repository is refused at the node
that needs one, `flows/build.md deliver/work.copies: <directory> is not in a
git repository`, before any model is called.

Everything that describes the work is in the file: its questions, its checks,
its copies, its commit. The command line holds only what belongs to whoever
types it: `--model`, the model every agent turn runs on, and `--timeout`, the
bound of one turn (`90s`, `10m`, `1h`). Both may lead the line or end it, and
an input written as one quoted string is the text inside the quotes.

Every run gets `runs/<timestamp>/`, its [run directory](flows.md#the-run-directory):
the snapshot, the journal, each subagent's transcript, this session's JSONL
and the `usage.json` a [`measuredRun`](flows.md#measuring-a-run) writes there
when the run ends. The widget above the prompt draws the flow's plan as the
visits go, each running visit expanded with what its subagents are doing under
it:

```
● build · 3 visits · 1m51s · ↑40k ↓4.1k
✓ locate · scout · 33s · ↑12k ↓831
✓ plan · planner · 10s · ↑9.8k ↓1.1k
● deliver · #1 of 2
  ● deliver#1
    ● deliver#1/work · 0/1 so far
      ● deliver#1/work[1]
        ● deliver#1/work[1]/pair · #1 of 3
          ● deliver#1/work[1]/pair#1
            ✓ deliver#1/work[1]/pair#1/code · coder · 37s · ↑18k ↓2.2k
            ● deliver#1/work[1]/pair#1/review
              ● reviewer#1  verdict approved=false raised=["Replace `t.strictEqual` wit… remarks=The tests use an inc…
    ○ deliver#1/tests · check .pi/checks/test.sh · timeout 10m · ≤ 20m
    ○ deliver#1/audit · agent auditor (.pi/agents/auditor.md) · reads input, work, tests, diff, deliver.ledger · verd…
○ report · agent synthesiser (.pi/agents/synthesiser.md) · reads input, diff, deliver.output.last.work, deliver.outpu…
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

A running subagent's line is its last call, its model, its tokens once a turn
has ended and its clock, cut to the terminal's width: the reviewer here is
calling `verdict`, and the call fills the room.

The plan takes sixteen rows at most. Past that it is cut above and below what
runs now, and each cut says how many lines it holds. The keys are those of any
run: `esc` stops it, `ctrl+↑↓` and `ctrl+del` stop one subagent.

When the run ends, its answer lands in the conversation as a message that
triggers no turn: the output of the flow's last root node, then one line on
how the run ended, then its last frame. The model reads the answer and the
line; the frame is drawn for you only.

```
◆ explore
Result of the explore flow, asked to: where is the condition language implemented?

The condition language (a subset of CEL) is implemented in the src/flow/condition/ directory.
…

ok · runs/2026-09-23_20-06-33

✓ explore · 5 visits · 27s · ↑44k ↓3.4k
✓ look · 3 items · 15s · ↑41k ↓2.8k
✓ answer · synthesiser · 12s · ↑2.4k ↓567
```

The line says `ok`, and `converged` or `not converged` when the last root node
is a loop. A failed run says where and why, then what a resume would do:
`failed at answer: provider: … · runs/… · /run resume runs/… picks it up at
answer`, or why it cannot be resumed.

`/run resume` takes the newest run under this directory's `runs/` that can go
on, and says which, and from which visit, before it starts:

```
run: resuming build in runs/2026-09-23_20-21-17, from deliver#1/work[1]/pair#1/code
```

`/run resume <run directory>` takes that one. A run that cannot go on is
refused with why: it ended well, it failed by a decision of the flow, its lock
is held by a live process, `HEAD` is off its branch (with the `git switch` to
type). The input and the model are the run's own, so `--model` is refused;
`--timeout` may be given again. What a resume keeps and what it runs again is
[Resuming a run](flows.md#resuming-a-run).

A refusal is fitted to the terminal before pi draws it: paths inside this
directory are named from here, and a line too long is cut before a path
rather than through it, the `Error: ` or `Warning: ` pi puts in front counted.


With herdr, `/herdr on` gives each subagent of a flow a split named by its
agent and where the flow keeps it, `coder @ deliver#1/work[1]/pair`, for as
long as that subagent lives. A `check`, an `ask` or a `commit` has no subagent,
and opens none.

## The question card

`/interview` asks through a card, and a flow's `ask` node asks through the
same one, whether `/run`, `/step` or the `subagent` tool runs the flow. A card
holds one question. It draws the header and the visit that asks, the reads
above the question, each under its name, then what takes the answer, and a
help line that says what the keys do:

```
────────────────────────────────────────────────────────────

 [plan]  review/1/go

 brief
   Add an in-memory cache in front of the store, with a TTL.

 Build this?

 → Build it                        start the subtasks
   Change the plan
   Stop here

 ↑↓ choose • enter answer • esc Stop here

────────────────────────────────────────────────────────────
```

What takes the answer depends on the form the caller asks for:

| Form | The card | The answer |
| --- | --- | --- |
| a choice, open | the options, then `Other…` for a typed answer | a label, or the typed text with `custom: true` |
| a choice, closed | the options only: literal labels take no typed answer beside them | a label |
| a yes or no | `Yes` and `No` | `"yes"` or `"no"` |
| a free text | a text box | what was typed, `""` when left empty |

`esc` declines the card, and the help line says what that means there. On the
interview's card it writes the brief with what you have. Where a flow's card
offers "that's enough", `esc` is that entry, under the label the flow gave it.
Where it offers none, `esc` stops the run, and the help line reads
`esc stop the run`. `esc` in the text box behind `Other…` goes back to the
options instead: a key pressed to leave a text box must not end a run. The
interview's `Other…` still opens pi's own text box, where `esc` submits.

A card also comes down when its question no longer stands. The flow runner
hands it a signal that aborts on the node's `timeout:` or on a stop. The card
closes, pi's editor comes back, and the answer is not read. For as long as a
card is up, the run's stop key is held and the widget stops offering it, so
pressing `esc` on it means only what the help line says. That holds during a
model's turn too: the card has the keys, and pi's own `esc`, which would end
the turn, does not reach it.

When the terminal is too narrow for the help line, each key goes on a line of
its own rather than being cut from what it does.

## Which pi it runs against

An extension is loaded into pi's own process, so it resolves **pi's** copy of the
package, not this repository's `node_modules`. The version that matters is the pi
you launched.

Homebrew ships 0.80.6, npm is on 0.80.10, and those two disagree on the model
API: 0.80.7 replaced `AuthStorage` and `ModelRegistry` with a single
`ModelRuntime`. A pi patch release can break the API.

The library therefore chooses by **presence of the export** rather than by
version string. A version number can be patched or mis-set; a missing export
cannot be faked.

This is the failure mode worth remembering: the whole suite was green while the
extension died on `undefined.create()` inside a real pi, because every test
injects a fake session and none of them touches pi's real module. **A fake
session cannot tell you the package it stands in for has changed shape.**
Anything that only runs against the real pi has to be exercised against the real
pi.

## How it is split

`extension/` is three places. Its root is the floor: `index.ts`, which keeps
only what genuinely needs a terminal - the renderers - and registers every
command; `execute.ts`, the tool body, where everything it touches is
injectable: agent loading, `spawn`, the second reporter, the UI, the repaint
timer; and the files below that every command stands on. `extension/commands/`
holds one file per slash command. `extension/ui/` holds what paints or reads the
terminal without registering anything. Each of the two has an `index.ts`, and
that index is the only file anything outside the directory imports.

pi comes in through one file, `extension/pi.ts`. It names the slice of pi's API
the extension registers through (`PiApi`) and the slice of pi's context a
command reads (`CommandCtx`, with `Ui` declared once and the narrower `RunUi`,
`KeyUi` and `AskUi` picked from it), and it holds the two wirings only that door
knows: what the tool body is handed (`ToolDeps`, which `execute.ts` widens with
what a test may replace), and how a command reaches the session. A
handler is written against `CommandCtx`; pi hands it the whole
`ExtensionCommandContext`, and TypeScript checks at every `registerCommand`
that the whole has what the slice reads. There is no cast between pi and a
command, so when pi changes shape the extension compiles red, and the fake a
test builds stands in for exactly what the code asked of pi.

The commands stand on one floor, in three files. `extension/deps.ts` is what a
command reaches for: `CommandDeps` are the doubles a test puts in place, and
`resolved()` fills what was left unsaid with the real thing, once, so a command
reads `deps.runDir` and never asks which it is. `extension/flags.ts` reads
what was typed. `extension/command.ts` is the shape every command that launches
work has: `CommandCtx`, the slice of pi it is handed; `loadRoster`, the same
roster everywhere; `checked()`, the checks that must pass before anything is
spawned, a thrown explanation becoming a refusal; and `watched()`, the live view
for as long as the work runs, with the `finally` that takes it down and writes
`usage.json` whatever happened. `/run`, `/step`, `/swarm` and `/interview`
each write their flags, their target and their call, and nothing of that
shape. A step of a hand-walked chain is `extension/relay.ts`'s to begin
and to finish - named before it runs, recorded and drawn in one call after -
whether `/step` or `/swarm` ran it; the entry a step leaves and the door it
leaves it through are both declared there. `/quote` sends the message `/run`
sends, which is `commands/answer.ts`'s. How a flow is launched, checked at
both stages, run under the plan's live view and measured in its run
directory, is `commands/launch.ts`'s, for `/run`, a flow stage of `/step` and
the tool's `flow` mode (`execute-flow.ts`) alike.

Each command's own file under `commands/` holds only what that command does.

That split exists because the path that wires the reporters and calls the
combinators is where the three worst bugs so far have hidden, each behind a green
suite. It is now covered offline.

**One live-run path.** The dots above the prompt, the repaint timer, the herdr
reporter and the clean-up are `liveRun()` in `extension/ui/run.ts` - one
implementation, reached only through `watched()`, which the four commands and the
`subagent` tool all stand on. They must look identical
while they run, and several call sites with several timers is exactly how the
one nobody is watching that day drifts. What a view measures - the picture, the
clock, `usage.json` - is the library's `measuredRun`, the same one an
experiment's cell stands on; the view only adds a terminal to it. `ui/run.ts`
paints and nothing else: a flow's plan is painted by `ui/flow.ts`, which draws
the frame a finished run's message ends on too, the herdr session switch is
`ui/herdr-switch.ts`, and
who owns escape while a question card is up is `ui/asking.ts`. The one thing the
view reaches in `commands/` is `/stop`'s `watchRun`, because a run has to be
known to the stop key for as long as it lasts.

## Reference

- [Display](display.md) - the widget, the tool row, herdr splits.
- [Deliver a change](build.md) - what `/run build` actually does.
- [Flows](flows.md) - the format `/run` runs.
- [Walk a chain by hand](chain-by-hand.md) - `/step`, `/chain` and `/quote`.
- [API reference](../reference/api/index.md) - the library the extension calls.
