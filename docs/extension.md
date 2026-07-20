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

What the run looks like while it happens is covered in [Display](display.md).

## The commands

| Command | What it does |
| --- | --- |
| `/interview <request>` | Turns a vague request into a brief, one question at a time. |
| `/build <request>` | Interview, then the build pipeline, then the commit. |
| `/build --pipeline <name> <request>` | The same, with a pipeline of your choosing. |
| `/build resume` | Carries on an interrupted build from `runs/<timestamp>/build.json`. |
| `/pipelines` | Lists the pipelines that are loaded, and the files that do not parse. |
| `/run <name> <input>` | Runs a pipeline with no interview and no commit stop. |
| `/herdr on\|off` | Give every subagent its own herdr split for this session. |

`/interview` and `/build` are commands rather than tools because a question card
owns the terminal until it is answered, and nobody can answer a question asked
inside a model's turn. See [Deliver a change](build.md) and
[Pipelines](pipelines.md).

Agents and pipelines both come from your own `~/.pi/agent/` or from the
repository you are in. **An extension never brings its own**: loading one with
`pi -e` must not be a way to acquire instructions you did not ask for, so
`pi -e ../elsewhere/extension` gives you the tool and the commands, never the
agents or the pipelines of that other directory.

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

`extension/index.ts` keeps only what genuinely needs a terminal - the renderers.
The tool body lives in `extension/execute.ts`, and everything it touches is
injectable: agent loading, `spawn`, the second reporter, the UI, the repaint
timer. The commands have the same seam in `extension/build.ts`, where the
interview, the delivery, the committer and every git call are injected.

That split exists because the path that wires the reporters and calls the
combinators is where the three worst bugs so far have hidden, each behind a green
suite. It is now covered offline.

## Reference

- [Display](display.md) - the widget, the tool row, herdr splits.
- [Deliver a change](build.md) - what `/build` actually does.
- [API reference](api/index.md) - the library the extension calls.
