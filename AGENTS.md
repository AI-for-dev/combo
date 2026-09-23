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
npm run docs    # regenerate docs/reference/api/ and flows/ - required after any signature change
pi -e extension # load the extension in a real pi (the only check fakes cannot do)
python3 scripts/drive-pi.py "/agents"   # the same, hands-free: it types and reads back
node scripts/check-herdr.ts     # hold our herdr calls to `herdr api schema --json`
```

Node >= 23.6 runs TypeScript natively. No build step. `erasableSyntaxOnly` is on:
no enums, no namespaces, no parameter properties.

## Invariants - violating one is a bug, whatever the task asked

1. **In-process via the pi SDK** (`createAgentSession()`), never
   `spawn("pi", …)`. That is what makes lifetime possible.
2. **The pi API lives in `src/session.ts` and nowhere else.** Everything else
   talks to `SessionPort`, a minimal subset - which is what lets tests inject a
   fake with no network, no disk and no `~/.pi`.
3. **Agents and flows are data; our code decides what runs next.** An agent is
   Markdown + frontmatter, a flow is YAML + Markdown built from a closed set of
   nodes, and a workflow is TypeScript combinators, for what a file cannot say.
   A model produces values, never the next node: our code reads them. A flow
   runs no code of its own (a `check` names a project script) and carries no
   templating (a node lists its `reads:`). It is validated whole before the
   first spawn, and **an agent never writes a flow**.
4. **Display is an observer, never a participant.** Reporters subscribe to the
   event stream; unplug them all and the result is identical. A listener that
   throws is swallowed.
5. **A subagent inherits nothing from the user's environment**
   (`StaticResourceLoader`, never `DefaultResourceLoader`). Three exceptions,
   and only three. `situate()`: its working directory, because that is the
   ground every tool call stands on. `delegateTool()`: an agent whose `tools:`
   names `subagent` is handed one, so it can split its task across children of
   its own. And `skills:`: a name written in the definition is resolved against
   `agents/<name>/skills/`, then the repository's, then the user's - the widest
   of the three, and the one to weigh before widening further. None of them is
   inheritance: what arrives is named in the file, and an agent that names
   nothing gets nothing. What an agent can do stays readable in its own file,
   which is the part of this rule that was ever load-bearing.

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
     `--model` put all four subagents on a model named nowhere in this
     repository, and an earlier run got `thinkingLevel: high`
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

    **What a subagent answers is the exception**, and not a matter of taste: it
    follows the language of the work it was handed, because whoever reads it
    asked in theirs. That is one instruction (`src/language.ts`), said **twice**
    - appended to every system prompt beside `situate()`, and again as the last
    line of every turn, because what a combinator frames the work with is
    English and arrives in the same message as the work. Never a line in a
    definition, which would miss every agent a user writes. A word the prompt
    asked for exactly (`READY`, `LGTM`, `APPROVED`, an agent name, a JSON key)
    is not translated, and that exemption is what the wording protects.

## Layout

```
src/                the library
  session.ts        the whole pi API, and nowhere else
  agent.ts subagent.ts run.ts result.ts usage.ts events.ts
  text.ts           reading what a model wrote: truncate, saysWord, jsonObjects
  tool.ts           a tool we offer: what an agent declared, how a call refuses
  delegate.ts       the subagent tool, for an agent whose `tools:` names it
  stop.ts           stopSwitch: one branch of a run, or the whole of it
  markdown.ts       finding and reading a .md with frontmatter
  skills.ts         resolving what an agent's `skills:` names, nearest first
  mirror.ts         a live subagent on a socket; mirror-wire.ts is the wire
  measure/          export (runs/<timestamp>/), measured (a run that measures
                    itself), experiment (M models, N repetitions), report;
                    lives (a flow run's, read from its journal) and
                    flow-usage (its visits, nodes and lives in usage.json);
                    index.ts is its door
  ask.ts verify.ts                      the ports that touch the world
  git/              run (git itself), git (what a pipeline may do), worktree
                    and scratch (the copies), tree (read without touching
                    it), land (patches come home), port (what a flow run may
                    ask); index.ts is its door
  builtin.ts        where the package's own agents/, pipelines/ and flows/ are
  board/            the swarm's board (board, claims, tool, agreement,
                    announced); index.ts is its door
  flow/             the flow format, exported beside pipeline/ until it
                    replaces it: file (the text, read into nodes), node (what
                    a node is: the closed lists of kinds and keys), read-node,
                    agent-node, ask-node, call-node, blocks, loop and world
                    (each kind; world holds the nodes that act, `check` and
                    `commit`), sections, value, fault (why a flow is refused),
                    catalogue (flows and agents on disk, broken files kept,
                    old pipelines/ refused), agents (a name resolved, skills
                    checked), check, check-agent, check-ask, check-call
                    (a callee resolved, cycles refused), check-blocks,
                    check-loop and check-world (the flow stage, against a
                    catalogue), check-run (the run stage: the tree, the ports),
                    unrolled (the nodes through calls), scope (what a node can
                    read), checked (what it hands on), bounds (its worst case,
                    in turns and time), sources (what a check read), memory
                    (the subagents a scope shares), type (what a value is),
                    schema (how a file writes one), condition/ (a
                    CEL subset: tokens, parse, compile, evaluate, address),
                    run/ (the runner: flow, world, walk, choice, blocks,
                    copies, loop, call, agent, ask and card (the person's side,
                    one card at a time), check, commit, turn, reads, submit,
                    verdict, frames, values, ended; journal (each fact, through
                    a port), snapshot (what a run started with), lock (one
                    runner per run) and transcripts (each subagent's, under
                    its home) in its run directory; replay (what a
                    resume keeps of the journal), resume-point (where it picks
                    up) and resume (resumeFlow); dry-run on answers, keys and
                    scripted); render/ (plan and text, the plan of a checked
                    flow; mermaid, its diagram; live, the plan filled as a
                    run goes, from visits, outcome and summary, written by
                    live-text);
                    index.ts is each one's door
  pipeline/         pipeline (the file), load (where it is), run (our code
                    walks the steps); index.ts is its door
  review/           review (the record), verdict (a decision as a tool call),
                    ledger (what is owed); index.ts is its door
  workflows/        chain fan-out loop reduce route orchestrate
                    interview plan swarm;
                    options.ts pool.ts (turn, hold, closeAll) concurrent.ts
    deliver/        deliver pair audit, settle (how the work reaches the
                    tree) and resume (build.json); index.ts is its door
  reporters/        picture (the stream folded once, for every reader), tree,
                    tui (formats, draws nothing), herdr and the probe that
                    asks it first, console, silent, record (the event stream
                    on disk), traffic (what passes on a board, worded once)
extension/          the pi extension: index.ts (tool, renderers), execute.ts
                    (the tool body) and the floor the commands stand on:
                    pi.ts deps.ts command.ts flags.ts params.ts relay.ts
  commands/         one file per slash command (flows is /flows); stage
                    beside /step, the command that uses it
  ui/               run (the live view), ask (the question card) and card
                    (what it draws around the answer), asking and
                    herdr-switch (two switches a card and a key share)
pane/               the client a herdr split runs, attached to the mirror
agents/ pipelines/ flows/
                    shipped definitions (symlinked into .pi/)
examples/ scripts/ test/
docs/               guide/ (task by task), reference/ (api/ and flows/,
                    generated), the landing page and the two project pages;
                    conf.py and _static/ build the same files into a site -
                    docs/README.md says how
```

**One file, one concept.** Past roughly 200 lines it is mixing two.

**One directory, one module.** Files whose headers name each other belong in a
directory, and its `index.ts` is the only file anything outside it imports -
tests excepted, they reach past every door. What the index does not list is
implementation, and stays so.

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
- **0.86 renamed the TUI class and stopped guessing tool renderers.** `TUI` is
  an interface now; `TuiMainScreen` draws where it drew, and `pane/tui.ts`
  chooses by presence. `ToolExecutionComponent` handed no definition no longer
  recognises pi's own tools by name, so `pane/renderers.ts` names them with
  `create*ToolDefinition`, which 0.80 and 0.86 both export. `ResourceLoader`
  also grew two members that only pi's interactive mode ever calls.
- `session.prompt()` takes **no `AbortSignal`** - bridge it to `session.abort()`,
  and remove the listener after the turn.
- A turn can **fail without throwing**: read the last assistant message's
  `stopReason`.
- **A `tool_execution_start` can carry an empty `toolName`.** Not missing,
  empty, so `??` never fires and the name reads as nothing at all. Anything
  taking a name off a pi event wants `|| "?"`, not `?? "?"`.
- Stats, context usage and exports are session methods: **call them before
  `dispose()`**, and always `dispose()` in a `finally`.
- The system prompt goes through the `resourceLoader`, not through a
  `systemPrompt` field. A read-only toolset is `["read", "grep", "find", "ls"]`.
- Reference docs live in `node_modules/@earendil-works/pi-coding-agent/docs/`
  (`sdk.md`, `extensions.md`, `tui.md`): read them before inventing an API, it
  probably exists. For herdr, `herdr api schema --json` is authoritative - and
  it moves: `agent.start` opened a pane under protocol 16 and starts an agent in
  an existing one under 22, which left `/herdr on` opening nothing while every
  test stayed green. `node scripts/check-herdr.ts` is what holds us to it.

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
| add or change a flow key, a node kind or a fault code | [docs/guide/flows.md](docs/guide/flows.md), then the header of `src/flow/file.ts` |
| move a pipeline to a flow | [docs/guide/from-pipelines.md](docs/guide/from-pipelines.md) |
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
an entry in a `toctree` on `docs/index.md` - that is the navigation, for the site
and for `npm test` alike - and `make -C docs html` builds with `-W`, where a
warning is a defect like any other.

## Other rules

This is rules for any bug fix, new feature, documentation, ... in the repository

- make the implementation clean and concise
- don't repeat yourself and use the rule "divide and conquer"
- never add your name in the commit, in the documentation, in the PR description
- avoid documentation or remark that is not useful
  - the number of tests passed is not relevant
  - the comment that indicates that theses lines fix the previous implementation is not relevant
- The PR must be small enough to be readable by a human. Split it if it's not the case