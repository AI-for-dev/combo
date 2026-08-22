# combo

A TypeScript library for writing [pi](https://pi.dev) subagents and composing
them into workflows. A subagent runs **in-process** through pi's SDK, so it is an
object whose lifetime you control, not a process you parse.

```
definition (.md)   ──►  Agent      "who"    : prompt, model, tools
spawn(agent)       ──►  Subagent   "alive"  : a session, a memory, a state
subagent.ask(task) ──►  Result     "one turn of work"
combinators        ──►  Workflow   "how"    : chain, fanOut, loop, orchestrate…
```

## Commands

```bash
npm test        # node --test 'test/*.test.ts' - offline, no network, ever
npm run typecheck
npm run docs    # regenerate docs/reference/api/ - required after any signature change
pi -e extension # load the extension in a real pi (the only check fakes cannot do)
```

Node >= 23.6 runs TypeScript natively. No build step. `erasableSyntaxOnly` is on:
no enums, no namespaces, no parameter properties.

## Invariants - violating one is a bug, whatever the task asked

1. **In-process via the pi SDK** (`createAgentSession()`), never
   `spawn("pi", …)`. That is what makes lifetime possible.
2. **The pi API lives in `src/session.ts` and nowhere else.** Everything else
   talks to `SessionPort`, a minimal subset - which is what lets tests inject a
   fake with no network, no disk and no `~/.pi`.
3. **Agents are data, workflows are code.** An agent is Markdown + frontmatter,
   a workflow is TypeScript combinators, a pipeline is a workflow written down.
   No YAML DSL, and **an agent never writes a pipeline**.
4. **Display is an observer, never a participant.** Reporters subscribe to the
   event stream; unplug them all and the result is identical. A listener that
   throws is swallowed.
5. **A subagent inherits nothing from the user's environment**
   (`StaticResourceLoader`, never `DefaultResourceLoader`). The single exception
   is `situate()`: its working directory, because that is the ground every tool
   call stands on.

   **The model is an explicit knob at every level, and the nearest override
   wins**: `SpawnOptions.model` / `WorkflowOptions.model` (also the tool's
   `model` param and `--model` on `/run` and `/build`) > the pipeline file's
   top-level `model:` > the agent's frontmatter `model:` > pi's own settings.
   The last resort is still `~/.pi/agent/settings.json` - when *nothing* was
   set at any level, pi decides. Which side of that is right depends on what
   the file is for:

   - **A definition that ships leaves it open.** None of the agents in
     `agents/` declares a `model:`, on purpose: a package that pinned one would
     override its user's own settings and break outright for anyone holding no
     key for that provider.
   - **A measurement pins it.** An experiment that left every level empty is
     measuring the operator, not the models. Measured: `/run explore` with no
     `--model` put all four subagents on `ilaas/gemma-4-31b`, a model named
     nowhere in this repository, and an earlier run got `thinkingLevel: high`
     nobody asked for. `experiment()` takes `models` and every command takes
     `--model` for exactly this: use them, and the run says on its face what it
     ran on.

   No environment variable is read anywhere: an ambient variable is how this
   hole existed, and the examples take `--model` in argv instead.
6. **`lifetime: "task"` is the default**; persistence is asked for, never
   obtained by accident. **Whoever opens, closes** - in a `finally`,
   cancellation included; a workflow that *receives* live subagents never closes
   them. Persistent subagents do not share history: you pass `Result`s, you do
   not merge contexts.
7. **The agents produce text, our code performs the act** (git, verify,
   questions). **A prompt is not a permission boundary**: a subagent that must
   not write gets no `write`/`edit` tool - asking it nicely has been tried, it
   edited the repository anyway. The committer has no `bash`.
8. **A failure is a `Result` with `ok: false`**, not a crash. `throw` only for
   programming errors (invalid configuration, unknown agent, closed subagent).
9. **Nothing is estimated.** Tokens and cost come from pi (`getSessionStats()`
   is cumulative → take the delta, clamp at 0); time is ours
   (`performance.now()`). A provider that reports nothing gives `0`, and we say
   so.
10. **Reaching a cap is not success**: `loop` reports `converged` apart from
    `ok`, and a reduction shows its failed branches rather than dropping them.
11. **No speculative abstraction.** A combinator, an option or a knob is added
    when a real example needs it - not before.
12. **English everywhere**: code, comments, documentation, agent prompts and
    commit messages. Only the conversation is French.

## Layout

```
src/                the library
  session.ts        the whole pi API, and nowhere else
  agent.ts subagent.ts run.ts result.ts usage.ts events.ts export.ts
  text.ts           reading what a model wrote: truncate, saysWord, jsonObjects
  markdown.ts       finding and reading a .md with frontmatter
  experiment.ts experiment-report.ts    one workflow, M models, N repetitions
  ask.ts verify.ts git.ts resume.ts     the ports that touch the world
  pipeline.ts pipeline-load.ts builtin.ts
  workflows/        chain fan-out loop reduce route orchestrate
                    interview pair deliver pipeline-run, common.ts
  reporters/        herdr, tui (collects and formats, draws nothing), console,
                    silent, record (the event stream on disk)
extension/          the pi extension: tool, commands, renderers, UI
agents/ pipelines/  shipped definitions (symlinked into .pi/)
examples/ scripts/ test/
docs/               guide/ (task by task), reference/ (api/, generated), the
                    landing page and the two project pages
```

**One file, one concept.** Past roughly 200 lines it is mixing two.

Every workflow is an exported **function** taking `{ lifetime, signal,
timeoutMs, openInHerdr, onEvent, bus, cwd, sessionDir, exportDir, spawn }` plus
what is specific to it. **`spawn` is injectable**, never a hard import - that is
what makes workflows testable offline. `timeoutMs` has **no default**: pi's agent
loop has no step cap, so a runaway turn needs something to fire the signal, but
the library does not get to decide a task took too long. `loop.maxIterations`
defaults to 5 and `orchestrate.maxTasks` to 8, because "forever" must not be
reachable by forgetting an argument.

## pi API traps, each paid for once

- **The pi that matters is the one the extension runs inside**, not the one in
  `node_modules`. Homebrew ships 0.80.6, npm 0.80.10, and 0.80.7 replaced
  `AuthStorage` + `ModelRegistry` with `ModelRuntime`. `buildRegistry` chooses by
  **presence of the export**, never by version string.
- **A fake session cannot tell you that pi changed shape.** 158 green tests while
  the extension died on `undefined.create()` in a real pi. Anything that touches
  the real module has to be run against the real module.
- `session.prompt()` takes **no `AbortSignal`** - bridge it to `session.abort()`,
  and remove the listener after the turn.
- A turn can **fail without throwing**: read the last assistant message's
  `stopReason`.
- Stats, context usage and exports are session methods: **call them before
  `dispose()`**, and always `dispose()` in a `finally`.
- The system prompt goes through the `resourceLoader`, not through a
  `systemPrompt` field. A read-only toolset is `["read", "grep", "find", "ls"]`.
- Reference docs live in `node_modules/@earendil-works/pi-coding-agent/docs/`
  (`sdk.md`, `extensions.md`, `tui.md`): read them before inventing an API, it
  probably exists. For herdr, `herdr api schema --json` is authoritative.

## Read before you write

Each of these is a page you are expected to open **before** touching that part,
not a bibliography:

| Before you… | Read |
|---|---|
| undo or contradict any design choice above | [docs/decisions.md](docs/decisions.md) - the full record, with the reversals and their reasons |
| add or change a combinator | [docs/guide/workflows.md](docs/guide/workflows.md), then the neighbouring `src/workflows/*.ts` |
| touch a lifetime, a `close()` or a pool | [docs/guide/lifetime.md](docs/guide/lifetime.md) |
| write a test, or a fake | [docs/development.md](docs/development.md#tests) - the fake session is cumulative, its `messages` grow, and its `abort()` really cuts the turn short |
| touch a reporter, the TUI or herdr | [docs/guide/display.md](docs/guide/display.md) |
| touch `Usage`, or an export | [docs/guide/measurements.md](docs/guide/measurements.md), [docs/guide/export.md](docs/guide/export.md) |
| change the extension, a command or a card | [docs/guide/extension.md](docs/guide/extension.md) |
| add or change a pipeline | [docs/guide/pipelines.md](docs/guide/pipelines.md), [docs/guide/build.md](docs/guide/build.md) |
| define an agent | [docs/guide/agents.md](docs/guide/agents.md) |
| pick up the project cold | [NEXT.md](NEXT.md) - what is left, and the traps already paid for |

## Conventions

TypeScript, ESM, tabs, double quotes - like pi's own code. TSDoc on every public
export, stating the invariant it upholds when that is not obvious; comments
explain **why**, never what. Dependencies are the pi SDK and nothing else without
discussion - never import its transitive packages. Before adding a layer of
configuration, ask whether a function call would do.

Documentation ships with the code, not after it: `README.md` and the affected
`docs/` page in the same batch, `npm run docs` for the generated reference, and
the decision written into `docs/decisions.md` when you took one. A new page needs
an entry in `docs/docs.json`, or the suite fails on a page nobody can reach.

## Other rules

This is rules for any bug fix, new feature, documentation, ... in the repository

- make the implementation clean and concise
- don't repeat yourself and use the rule "divide and conquer"
- never add your name in the commit, in the documentation, in the PR description
- avoid documentation or remark that is not useful
  - the number of tests passed is not relevant
  - the comment that indicates that theses lines fix the previous implementation is not relevant
- The PR must be small enough to be readable by a human. Split it if it's not the case