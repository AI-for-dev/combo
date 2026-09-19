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

The interview writes its transcript into the run's folder, the same
`runs/<timestamp>/` the pipeline uses: one run, one folder. That folder is made
**before** the interview rather than after it, because a failed interview is the
one moment "what was actually sent" is the only question worth asking, and it
used to leave nothing to read. The failure names the folder.

The interview is watched the way the pipeline is: a row per subagent, with what
it is reading. Measured on this repository against a small open-weight model,
its first turn is 35 seconds and seven file reads, and the whole interview 57
seconds over three turns. Without the row that first turn is half a minute of a
status line that does not move, which is indistinguishable from a turn that has
hung.

**`--model` covers the interview too**, and `--questions` caps how many it asks.
The interviewer reads the repository between questions rather than asking what
it could find out, so a question is an exploration and not a round trip: six of
them on a slow model is the whole of `/build` before any work starts. Each turn
gets a five minute deadline, because pi's agent loop has no step cap and a
person waiting cannot tell a slow turn from a stuck one.

`--worktree` takes no value, unlike `--model`: a flag that swallowed the word
after it would eat the first word of the request. Saying nothing is **not** the
same as saying no: a delivery left to itself gives each of several subtasks a
copy of the repository, and `--worktree=false` is how you refuse that.
`--worktree` forces it on for a delivery of one. See [Worktrees](worktree.md)
for what it costs and what it buys.

`until` is a **whole-line match**: the loop stops when the word stands alone on
one of the lines, whatever decoration the model put around it. A line with
anything else on it does not count, so a review that writes "I cannot say LGTM
yet" keeps the loop going. A pipeline step's `until:` and `pair`'s approval read
the same way, through [`saysWord`](../reference/api/text.md).

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
| `/build <request>` | Interview, then the build pipeline, then the commit. |
| `/build --pipeline <name> <request>` | The same, with a pipeline of your choosing. |
| `/build --model <pattern> <request>` | The same, with every subagent on that model. Checked before the interview: a typo costs a second. |
| `/build --worktree=false <request>` | The same, with the subtasks sharing one working tree rather than a copy each. |
| `/build resume` | Carries on an interrupted build from `runs/<timestamp>/build.json`. |
| `/agents` | Lists the agents that can be spawned, grouped by where they came from. |
| `/pipelines` | Lists the pipelines that are loaded, and the files that do not parse. |
| `/run [--model <pattern>] [--worktree] <name> <input>` | Runs a pipeline with no interview and no commit stop; its answer lands in the conversation. |
| `/step [--from <id>] [--model <pattern>] [--agent] <name> <instruction>` | Runs one agent or pipeline on the previous step's output. Drawn, and kept out of this session's context. |
| `/swarm [--members <n>] [--claim a,b] [--hold <n>] [--rounds <n>] [--agent <name>] [--model <pattern>] <goal>` | Several copies of one agent on one job, with a board between them. Drawn as a step of the chain, like `/step`. |
| `/chain`, `/chain reset` | The steps walked so far; or drop them and start a new chain. |
| `/quote [id]` | Put one step of the chain into the conversation, attributed. |
| `/stop [<id>\|all]` | Stops the selected subagent, one named by id, or the whole run. `esc` and `ctrl+del` do the same from the keyboard. |
| `/herdr on\|off` | Give every subagent its own herdr split for this session. |

`/interview` and `/build` are commands rather than tools because a question card
owns the terminal until it is answered, and nobody can answer a question asked
inside a model's turn. See [Deliver a change](build.md) and
[Pipelines](pipelines.md).

`/step` is the other way of running a pipeline's worth of work: one stage per
command, with this session kept out of it until you say otherwise. See
[Walk a chain by hand](chain-by-hand.md).

**The extension brings its own agents and pipelines**, so it works the moment it
is loaded rather than only inside a repository where the definitions were copied
by hand. They sit at the **lowest priority**: a definition of the same name in
`~/.pi/agent/` replaces one of ours, and one in the repository replaces both.

That is safe for a reason worth stating plainly: loading an extension already
runs its code - pi's own documentation says so - so reading Markdown from the
same directory adds no risk that installing it did not already accept. What
matters is that it can never take a name away from you.

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

`extension/index.ts` keeps only what genuinely needs a terminal - the renderers -
and registers every command. The tool body lives in `extension/execute.ts`, and
everything it touches is injectable: agent loading, `spawn`, the second
reporter, the UI, the repaint timer. The commands have the same seam, and it is
declared once in `extension/command.ts`: `CommandCtx` is the slice of pi they
are handed, `BuildDeps` the doubles a test puts in its place, and `loadRoster`,
`choosePipeline`, the flag parser and `refuse` are the things all of them do the
same way.

Each command's own file holds only what that command does, `/build` included:
the interview it opens with is `interview-command.ts`, which is a command in its
own right, the commit it ends on is `commit.ts`, and `build.ts` is the order
they happen in. The two stops sit apart from the state machine on purpose -
"the agent writes the message, this code makes the commit" is a boundary that
should be readable in one file.

That split exists because the path that wires the reporters and calls the
combinators is where the three worst bugs so far have hidden, each behind a green
suite. It is now covered offline.

**One live-run path.** The dots above the prompt, the repaint timer, the herdr
reporter, the clean-up and `usage.json` are `liveRun()` in
`extension/run-ui.ts` - one implementation, used by the `subagent` tool,
`/build` and `/run`. They must look identical while they run, and three call
sites with three timers is exactly how the one nobody is watching that day
drifts. It reaches for neither the tool nor the commands, so the dependency runs
one way.

## Reference

- [Display](display.md) - the widget, the tool row, herdr splits.
- [Deliver a change](build.md) - what `/build` actually does.
- [Walk a chain by hand](chain-by-hand.md) - `/step`, `/chain` and `/quote`.
- [API reference](../reference/api/index.md) - the library the extension calls.
