# Design decisions

Why combo is shaped the way it is, and what was reversed along the way.
This page records **decisions**, not the state of the code: read the relevant
section before undoing a design choice, and add to it when you take one.

[AGENTS.md](../AGENTS.md) holds the short version - the invariants an agent must
not violate. The rest of [docs/](index.md) explains how to use what these
decisions produced.

## Structural decisions (do not undo without discussion)

1. **In-process execution through the pi SDK** (`createAgentSession()` from
   `@earendil-works/pi-coding-agent`), not `spawn("pi", ["--mode", "json"])`.
   Each subagent is an `AgentSession` with its own context, model and tools. No
   NDJSON parsing, no process startup cost, native events, testable without a
   network. It is also what makes **persistence** possible: a session we keep
   alive.
2. **Two surfaces, one core**: the logic lives in a pure TS library (`src/`),
   and a **pi extension** (`extension/`) exposes it as a tool in the TUI. Every
   feature must be usable from a script *before* it is exposed in the extension.
3. **Agents are data, workflows are code.** An agent is declared in Markdown +
   frontmatter (pi's convention); a workflow is written in TypeScript with
   combinators. No YAML DSL: we want composable code, not a configuration
   engine.
4. **Display is an observer, never a participant.** No workflow may depend on a
   UI being present. *Reporters* (herdr, pi TUI, silent) subscribe to an event
   stream; unplug them all and the result is identical.
5. **The pi API lives in one file.** `src/session.ts` is the only place that
   imports from `@earendil-works/pi-coding-agent`. Everything else talks to
   `SessionPort`, a minimal subset of `AgentSession`. When pi moves, one file
   moves - and tests inject a fake session with no network, no disk, no `~/.pi`.
6. **A subagent inherits nothing from the user's environment.** Its system
   prompt goes through our own `StaticResourceLoader`: no extensions, no
   skills, no context files. `DefaultResourceLoader` would re-read the disk on
   every spawn and pull in non-deterministic context nobody asked for.
7. **English everywhere** - documentation, comments, public API, agent system
   prompts, and **git commit messages**. Everything that lands in the repository
   or in its history is English.

## Mental model

```
definition (.md)   ──►  Agent      "who"    : prompt, model, tools
spawn(agent)       ──►  Subagent   "alive"  : a session, a memory, a state
subagent.ask(task) ──►  Result     "one turn of work"
combinators        ──►  Workflow   "how"    : chain, fanOut, orchestrate, loop
```

Two levels of API, the second built on the first:

```typescript
// Low level: a live subagent whose lifetime you control
const coder = await spawn(agents.coder, { lifetime: "workflow" });
await coder.ask("Implement the parser");
await coder.ask("Apply these remarks: …");   // it remembers the previous turn
await coder.close();

// High level: disposable, everything is handled (spawn → ask → close)
const result = await run(agents.scout, "Find the authentication code");
```

`Result` is the one contract shared by everything else:

```typescript
type Result = {
  agent: string;
  output: string;          // last assistant text
  messages: AgentMessage[];
  usage: Usage;            // time, tokens, cost, turns, context
  ok: boolean;
  error?: string;
};
```

A workflow is a function `(input) => Promise<Result | Result[]>`. Workflows
compose because they share that signature - that is all.

## Subagent lifetime

**The central point of the project.** A subagent is a session: keeping it open
means keeping a context, a memory, and a token cost that accumulates. Closing it
means starting clean but amnesic. Both are legitimate; the choice must be
**explicit and local**.

| `lifetime` | The subagent… | Cost / context | When |
|-----------|----------------|-----------------|-------|
| `"task"` *(default)* | is born and dies with each task | minimal context, reproducible | exploration, fan-out, independent tasks |
| `"workflow"` | lives for the workflow | remembers iterations, growing context | coding↔review loop, iterative refinement |
| `"session"` | lives as long as the pi session | long memory, watch it | "companion" agent consulted several times |

### Coding ↔ review loop: the two regimes

Same workflow, two behaviours, one parameter:

```typescript
// "Team" regime: coder and reviewer remember the previous turns.
// The reviewer does not repeat its remarks, the coder knows what it was told.
await loop({
  steps: [agents.coder, agents.reviewer],
  lifetime: "workflow",
  until: (r) => r.output.includes("LGTM"),
  maxIterations: 5,
});

// "Freshness" regime: brand new subagents at every iteration.
// No accumulated bias, every review starts from the code alone. More expensive
// in re-reading, more honest about the result.
await loop({
  steps: [agents.coder, agents.reviewer],
  lifetime: "task",
  until: (r) => r.output.includes("LGTM"),
});
```

Rules:

- **`"task"` is the default.** Persistence is asked for, it is never obtained by
  accident.
- **A persistent `Subagent` is an explicit object** with `ask()`, `usage`,
  `close()`. There is no global session cache hidden behind `run()`.
- **Whoever opens, closes.** The owner of a `Subagent` is whoever `spawn()`ed
  it. A workflow that creates its subagents closes them in a `finally`,
  cancellation included. A workflow that *receives* live subagents **never**
  closes them.
- **Persistent subagents do not share their history.** "Working together" means
  passing `Result`s as input, not merging contexts. If an agent must see another
  one's work, you **tell** it in the task.
- **Context growth is visible**: `subagent.usage.contextTokens` is reported to
  the TUI. A `"workflow"` agent approaching its limit must either compact
  (`session.compact()`) or fail cleanly - never truncate silently.
- **No shared mutable state** between fan-out branches, whatever the lifetime.

## Workflows to cover

| Workflow | Shape | Semantics | Status |
|----------|-------|------------|--------|
| `chain` | 1→1→1 | output of step *n* is the input of *n+1* | done |
| `fanOut` | 1→N | N subtasks in parallel, bounded concurrency | done |
| `loop` | 1→1 | iterates until a criterion (judge, test, regex) is met | done |
| `reduce` | N→1 | one agent synthesises a fan-out's results | done |
| `interview` | user→1 | an agent questions the *user*, one question at a time, and writes a brief | done |
| `pair` | 1→1 | a worker and a reviewer discuss until the work is accepted | done |
| `deliver` | brief→? | plan, a pair per subtask, a check, an audit, fixes | done |
| `orchestrate` | 1→? | an agent *decides* the split, then delegates (dynamic fan-out) | done |
| `route` | 1→1 | a classifier agent picks the destination agent | done |

Rules:

- **Every workflow is an exported function**, not a class. No inheritance, no
  global registry.
- They all accept `{ lifetime, signal, timeoutMs, openInHerdr, onEvent, bus, cwd,
  sessionDir, exportDir, spawn }` - same names, same defaults (`"task"`, then none) - plus whatever is
  specific to them (`concurrency` and `failFast` for `fanOut`, `until` and
  `maxIterations` for `loop`).
- **`spawn` is an injectable parameter**, never a hard import inside a
  combinator. That is what makes workflows testable without a network.
- **Cancellation propagates**: the `AbortSignal` reaches every turn and closes
  the sessions that were opened.
- **`timeoutMs` is a per-turn deadline, with no default.** pi's agent loop is a
  `while (true)` (`pi-agent-core/dist/agent-loop.js:84`) with **no step cap**: it
  runs as long as the model keeps requesting tools. A weak model that
  hallucinates a tool name, gets "unknown tool" back and asks again will loop
  until something stops it - observed in the wild, 79 calls to a non-existent
  `run` tool, ~500k input tokens in a single turn. A signal alone is not enough:
  something has to fire it. No default value, though - the library does not get
  to decide that a legitimate task took too long.
- **`loop`'s `maxIterations` does have a default (5).** That is not
  inconsistent with the above: an iteration is a discrete, expensive unit with a
  meaningful small default, whereas any default wall-clock deadline would be
  arbitrary. The two guards sit at different levels - `timeoutMs` inside a turn,
  `maxIterations` between turns - and "loop forever" must not be reachable by
  forgetting an argument.
- **Reaching a cap is not success.** `loop` reports `converged` separately from
  `ok`: `ok` says the last turn ran without a model error, `converged` says the
  work reached the bar. A loop that burns through `maxIterations` with every
  turn technically fine is `ok: true, converged: false`, and collapsing those
  two into one boolean would hide the only thing worth knowing.
- **A failure does not crash the workflow**: it becomes a `Result` with
  `ok: false`. It is the caller (or an explicit `failFast` option) that decides
  to stop.
- **A reduction shows its failed branches, it does not drop them.** A synthesis
  built from six branches when two of them crashed, with nothing saying so, is a
  confident lie - and the caller can no longer tell a thin answer from a thin
  body of evidence. `formatBranches` labels them; a caller who really wants only
  the successes filters the array, which needs no option.
- **`reduce` returns the branches in `steps`**, followed by the synthesis. The
  cost of an N→1 is the cost of everything that produced it, and a `Result.usage`
  is always one turn - so the total has to be summable from `steps`.
- **Lifetime cannot change the shape of every combinator.** `reduce` is one
  agent and one turn: `"task"` and `"workflow"` both spawn once. The lifetime
  test then asserts what is actually observable (the option reaches the spawn,
  and the subagent is closed either way) rather than inventing a spawn count
  difference that does not exist.
- **How the decision of a deciding agent is read: a parsed convention.** That
  was `orchestrate`'s one open question, and the answer is `parsePlan`. The
  alternatives were weighed: a **tool call** is possible (`createAgentSession`
  takes `customTools`) and would give validated arguments, but it means teaching
  `SessionPort` about tool definitions and betting the combinator on a model
  that reliably emits tool calls - the weak models this library is run against
  do not. **Structured output** is not uniformly available across providers, and
  `prompt()` returns text either way. A parsed convention costs one function,
  works everywhere, and the check that actually matters - is this a real agent
  name? - is a lookup no schema would have replaced.
- **The parsers are lenient, and only they.** `parsePlan` and `pickDestination`
  read what a *model* wrote, not what a caller passed; everywhere else a
  malformed input is an error. The leniency is not a guess, though: an
  unrecognised agent name is **dropped**, never remapped onto a plausible
  neighbour, and an ambiguous routing answer resolves to nothing rather than to
  the first match. Silently doing the wrong work is worse than failing.
- **Leniency is decided by real runs, not by taste.** Asked for a JSON array,
  the planner answered with bare objects and no brackets - a green suite and a
  reasonable-looking prompt had said nothing. `parseJsonPlan` therefore collects
  every `{…}` block that carries `agent` and `task`, in order, so an array, a
  lone object, several objects on their own lines and a fenced block all reduce
  to the same plan.
- **Routing reads the agents' `description`.** That field is already mandatory,
  so routing needs no second vocabulary to maintain - and a vague description
  produces vague routing that no parser can repair.
- **`orchestrate` caps the plan (`maxTasks`, default 8) and fails before
  spawning.** Every subtask is a session and a bill; a plan of two hundred steps
  must not be reachable by a hallucination, and losing a run costs less than
  paying for a runaway one. Same reasoning as `loop`'s `maxIterations`, one
  level up.
- **Independence cannot be enforced, only asked for.** The planning prompt
  insists that subtasks run in parallel, and a weak planner still produced a
  step beginning "review the code identified by the scout". Nothing in the
  combinator can check that, and adding a dependency graph would be building
  `chain` a second time. When the work is sequential, use `chain`.
- **Reading code is not running it.** `deliver` takes a `verify` port, and when
  one is given **its verdict is final**: no approval makes a failing check a
  success. This is not a precaution, it is a bug that shipped - in a real run a
  pair wrote a helper and its tests, the reviewer approved, the auditor
  approved, and the test file imported `./slugify.js` for a file named
  `slugify.ts`. The suite never even loaded. Both agents had read the code.
- **An agent that decides must see the roster.** The planner was given the list
  of workers and the auditor was not, so it answered `agent: fix the quote` -
  literally the word "agent" - and every fix was dropped as an unknown name.
  Found by a real run, not by a test.
- **A refusal in prose still has to reach someone.** An auditor that explains the
  fix in English and names nobody is refusing all the same. With exactly one
  worker the whole review goes to them - there is no ambiguity to resolve. With
  several, dropping it stays right: guessing who owns a fix is how the wrong
  file gets rewritten.
- **No speculative abstraction**: a combinator is added when a real example
  needs it. `reduce` is deliberately not chunked: folding branches in batches to
  fit a context window is a real need when it appears, and until it does it
  would be a configuration knob nobody asked for.

## Pipelines: a workflow written down

`src/pipeline.ts` parses one, `src/pipeline-load.ts` finds it, and
`src/workflows/pipeline-run.ts` walks it. `/build` runs one.

- **`/build` has no built-in behaviour any more, it has a default file.**
  `DEFAULT_BUILD_PIPELINE` is a pipeline like any other, parsed by the same
  parser and run by the same runner. Had the command kept a hard-coded path
  "for the simple case", that path and the pipeline path would have drifted
  within two changes, and the file would have become the untested one.
- **Only the middle is a pipeline.** The interview and the commit stay stops of
  the command: a question card owns the terminal, and "the agent writes the
  message, our code makes the commit" is a boundary a file must not be able to
  move. A pipeline describes *work*, not *acts on the world* - which is also why
  `runPipeline` takes a `Verify` port and never builds one from the `verify`
  field itself. Naming a command and running it are two decisions, and the
  second belongs to whoever owns the working tree.
- **An agent does not write pipelines.** It was considered and dropped: what a
  generated pipeline buys is a reviewable artefact, and `orchestrate` already
  gives that with a parser and a cap. A second, larger place where a model
  decides the shape of a run is more surface for the same benefit. A user writes
  the file; the file is data; the run is ours.
- **A broken `build.md` is refused, never silently replaced by the default.**
  The whole point of `findPipeline` reporting a parse error is that a file
  sitting right there and quietly not being used is the failure nobody detects.
- **Everything is resolved before the interview.** Parsing, shape checks and
  every agent name, so a typo costs a second rather than a conversation and
  three steps of real work. That is the same reasoning as `orchestrate`
  validating a plan before spawning, one level up.
- **Resuming is keyed by step id.** `BuildState.step` is optional: a state
  written before pipelines existed has none, and a single-delivery pipeline has
  nothing to disambiguate. It earns its place the day a pipeline delivers twice,
  where handing the second delivery the first one's approved subtasks would
  resume the wrong work.
- **A `loop` that never converges fails its pipeline.** Passing unconverged work
  to the next step is exactly the silent success `converged` exists to expose;
  in code the caller reads the flag, and in a file there is nobody to read it.
- **`reduce` folds the step before it.** That is what the linear rule buys: no
  templating, no `${{ steps.x.output }}`, and the one N-to-1 case that matters
  still works. A `reduce` with nothing to fold fails without spawning. It is
  handed those branches **once**: `reduce` formats them itself from `results`,
  so passing the previous output as text too printed every report twice - and
  the synthesiser duly reported "duplicate reports, verbatim duplicates".
- **The request reaches every step, not only the first.** A step that sees only
  the previous output cannot tell what the run was for. Found by a real run of
  `explore`: the synthesiser answered "there is no question asked in the
  prompt", because there was not - the user's question had been overwritten by
  the fan-out's output. The same bug silently starved the shipped `build`
  pipeline, whose delivery step saw the scout's report and never the brief. The
  dataflow is therefore two named sections, `## Request` and `## Output of step
  <id>`, and not one anonymous blob: a model asked to answer a question it
  cannot distinguish from the evidence answers about the evidence.
- **A subagent is told where it is.** One line appended to its system prompt by
  `situate()`. It sits oddly beside "a subagent inherits nothing from the user's
  environment", and it is not the same thing: the working directory is not
  inherited context, it is the ground every tool call stands on. A scout that
  was not told called `ls /Users/loic/gouarin/…` - a name with a dot turned into
  a slash - got "no such path", and gave up without trying a relative one. One
  branch of three, spent on a fabricated path.
- **`/run` exists because `/build` delivers a change.** An interview settles what
  "done" means and a commit stop protects history; a pipeline that only reads
  needs neither, and putting one through `/build` means being interviewed about a
  request that wants no decision and then told there is nothing to commit. `/run`
  is the pipeline and its answer, nothing around it - and it is **lighter, not
  safer**: what a step writes is still written, because what an agent may do is
  its toolset, never the command that started it.
- **A finished `/run` leaves its answer in the conversation, not in the prompt
  editor.** The editor is right for `/interview` - a brief is read, edited and
  sent - and wrong for an exploration, which is read and then *asked about*:
  putting it where the user types means they have to send their own report back
  before the model knows anything about it. It is a **custom** message and not an
  assistant one because pi has no door for the latter: `sendMessage` (custom, in
  context), `sendUserMessage` (a user message, always triggers a turn) and
  `appendEntry` (drawn, invisible to the model) are all there is, and
  `convertToLlm` turns a custom message into the **user** role. Hence the
  framing line naming the pipeline: unattributed findings in a user slot read as
  an instruction.
- **`/pipelines` is there because the error message was not enough.** A pipeline
  of one repository is invisible from another - by design - and the failure
  reported where pipelines live without saying what had been loaded, with no way
  to ask. Found by running it in a scratch directory, not by reading the code.
  The listing shows the broken files **beside** the good ones: a file that does
  not parse is the most likely reason anyone is looking.
- **The extension does bring its own agents and pipelines, at the lowest
  priority.** This **reverses** the rule written one commit earlier ("an
  extension never brings its own"), and the reversal is the honest one: loading
  an extension already runs its code - pi's own documentation says so - so
  reading Markdown from the same directory adds no risk that installing it did
  not already accept. What the old rule was really protecting is *not silently
  losing a name*, and precedence protects that directly: shipped, then the
  user's, then the repository's, so a `scout.md` of your own replaces ours
  without removing anything. `builtin` is **off by default** in the library: a
  script asking for the user's agents must not be handed ours as well. Found the
  hard way - `/build --pipeline explore` in a scratch directory found nothing at
  all, because the definitions only existed in this repository.
- **One default, and it is a file.** `DEFAULT_BUILD_PIPELINE` lived exactly as
  long as it took to ship `pipelines/build.md`: a default written in TypeScript
  *and* a default written in Markdown would have differed within two changes,
  which is the drift the constant was introduced to prevent in the first place.
  The shipped file names **no `verify`**, deliberately - imposing `npm test` on a
  project that has none is worse than asking, and `/build` asks when the pipeline
  is silent.
- **`/build` and `/run` paint the same run the same way**, through one
  `liveRun` in `extension/run-ui.ts`: two call sites, two timers and two ways of
  clearing a widget is exactly how the one nobody is watching that day drifts.

## Measurements: time and tokens per subagent

Nothing is estimated, nothing is recomputed by hand: pi already exposes the
numbers, we **collect and attribute** them. The only things the library adds are
**time** (pi does not measure it) and **aggregation per subagent**.

```typescript
type Usage = {
  // time - measured here, on a monotonic clock (performance.now()), not Date.now()
  wallMs: number;        // from spawn to close (includes waiting between two asks)
  busyMs: number;        // time actually spent working (sum of the asks)
  turns: number;

  // tokens & cost - reported by pi, never reconstructed
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens?: number;  // current context size (persistent agent)
};
```

Where the numbers come from:

- `session.getSessionStats()` → `{ tokens: { input, output, cacheRead,
  cacheWrite, total }, cost, contextUsage, userMessages, assistantMessages,
  toolCalls, … }`. This is **the** source of truth for tokens and cost.
- `session.getContextUsage()` → context occupancy, to display for persistent
  agents.
- Time is measured around each `session.prompt()`: `busyMs` is the sum of the
  `ask` calls, `wallMs` runs from `spawn` to `close`. On a `"task"` agent the
  two are nearly equal; on a `"workflow"` agent the gap between them **is** the
  interesting information (waiting time vs useful time).

Rules:

- **`getSessionStats()` is cumulative over the session.** A turn's usage is
  therefore the **difference** between two snapshots, taken before and after
  `prompt()`. That is what gives both `subagent.usage` (since spawn) and
  `result.usage` (this turn) without ever recounting a token.
- Counters are clamped at `0`: compaction can walk the totals backwards, and a
  negative usage means nothing.
- **A fan-out aggregates**, it does not average: total tokens, total cost,
  `wallMs` = duration of the fan-out (not the sum of the branches), `busyMs` =
  sum of the branches. The ratio of the two gives the real parallelism - that is
  what we want to see.
- **A failure counts too.** A subagent that crashed after 12k tokens cost 12k
  tokens; its `Usage` is filled in even when `ok: false`.
- **Never** estimate tokens by counting characters. If the provider does not
  report them, the field is `0` and we say so.

## Session export

Two formats, two uses, both provided by pi (`AgentSession`):

```typescript
await session.exportToHtml(outputPath?);  // → path of the HTML file, readable/shareable
session.exportToJsonl(outputPath?);       // → JSONL of the current branch, replayable
```

Implemented in `src/export.ts`, wired into `spawn` and every workflow through
`exportDir`.

- **An export covering the parent session *and* all its subagents.** An
  orchestration export that lost the subagents' work would be useless. What lands
  in `runs/<timestamp>/`: one `<agent>-<n>.html` / `.jsonl` pair per subagent,
  `main.jsonl` for the parent, and a `usage.json`.
- **`main.html` is not there, and will not be.** pi's HTML renderer is a method
  of `AgentSession`; an extension only ever gets a `ReadonlySessionManager`
  (`ctx.sessionManager`), and `exportFromFile` is not re-exported from the
  package root - the `exports` map blocks a deep import. So we copy the parent's
  JSONL, which pi's own `pi --export <file>` turns into the same HTML on demand.
  Writing our own HTML would break "we reimplement nothing".
- **`exportDir` implies a session directory**, `<exportDir>/.sessions`.
  `SessionManager.inMemory()` persists nothing, and pi answers a request to
  export one with `Cannot export in-memory session to HTML`. Asking for an
  export *is* asking for the session to be kept long enough to export it - one
  decision, not two. `sessionDir` stays available for anyone who wants the
  working files elsewhere. Neither is a default: with no `exportDir`, a subagent
  leaves nothing behind, not in `~/.pi` and not in the working directory.
- **JSONL and HTML are attempted separately.** An in-memory session still yields
  its transcript even though pi refuses to render its page; losing both because
  one is impossible would be a poor trade.
- **Export can be triggered at any time**, not only at the end of a workflow:
  `subagent.export(dir)` works on any live subagent. `close()` exports first and
  disposes after, so the workflow's `finally` - cancellation included - is
  already the "export what was done" path. What is written on the interrupted
  path is what makes this feature worth having.
- **An export never throws.** Every failure is a string in `SessionExport.error`.
  An export is an observer of the run, and an observer that takes the workflow
  down with it is a bug - most of all when it runs on the way out of a crash.
- **`usage.json` is the only artefact we produce ourselves**; we reimplement
  neither pi's HTML nor its JSONL. It is built from the same `TuiSnapshot` the
  TUI draws (`usageReport(snapshot, wallMs)`) - one collected state, two
  consumers - and it carries what pi cannot: time, attribution per subagent, and
  `parallelism` (busy over wall).
- Not to be confused with `pi --export <file>` (CLI, on an existing session
  file): useful when debugging, and the way to render `main.jsonl`.

## Display: herdr if present, pi TUI otherwise

One event stream, several reporters. The core emits:

```typescript
type SubagentEvent =
  | { type: "spawn";  id: string; agent: string; lifetime: Lifetime }
  | { type: "status"; id: string; status: "working" | "idle" | "blocked" | "done"; task?: string }
  | { type: "text";   id: string; delta: string }
  | { type: "tool";   id: string; name: string; args: unknown }
  | { type: "usage";  id: string; usage: Usage }
  | { type: "close";  id: string; result: Result };
```

A listener that throws is swallowed: a broken reporter must never take a
workflow down with it.

**The task rides on the `"working"` transition**, not on `spawn`: at spawn time
nobody knows yet what the subagent will be asked, and a persistent subagent is
asked several different things over its life. A reporter has no other way to
learn it - and until it did, every collapsed row in the TUI showed a blank task.

### herdr reporter (the default when available)

Implemented in `src/reporters/herdr.ts`, transport in `herdr-client.ts`.
Verified against herdr 0.7.3, protocol 16.

**The key idea, because it is not the obvious one.** A herdr pane cannot *host*
an in-process subagent: there is no process and no TTY to attach, while
`pane.split` and `agent.start` launch an argv in a real terminal. So the pane
does not host the subagent - it **displays a stream we write**. We append to a
file and open a pane running `tail -n +1 -f` on it:

```typescript
agent.start { name: "reviewer#2", argv: ["tail", "-n", "+1", "-f", logPath], split: "right" }
```

This also settles the ownership question: a pane carries exactly **one** `agent`
/ `agent_status`, and the main pane's already belongs to herdr's own pi
integration (source `herdr:pi`, installed at
`~/.pi/agent/extensions/herdr-agent-state.ts` - read it, it is the reference
implementation). The panes we open are ours, so we report on those and never
fight for the main one.

**Detection**: `HERDR_ENV === "1"` **and** `HERDR_SOCKET_PATH` **and**
`HERDR_PANE_ID`. All three, or nothing. Missing them is the normal case outside
herdr, so we fall back silently: **never an error, never a noisy warning**.

**Transport**: unix socket, newline-delimited JSON, one connection per request,
resolve on the first `data`, then `destroy()`. First attempt at 500 ms, one
retry at 1500 ms, then give up quietly. Envelope `{ id, method, params }`.

Points that cost time to discover:

- **`PaneAgentState` has no `done`** - it is `idle | working | blocked |
  unknown`, even though the *event* `AgentStatus` enum does have `done`. Our
  `"done"` maps to `idle`, and `pane.release_agent` is what actually retires the
  agent.
- **`agent.start` answers with the `pane_id`** (`result.agent.pane_id`), which
  is the only way to later report on, release and close that pane.
- **Release before close.** Closing first leaves herdr holding an agent on a
  pane that no longer exists.
- **Every promise chain ends in a `catch`.** A try/catch around the listener is
  not enough: an unhandled rejection escapes it entirely and takes the process
  down. Found by a test, not by reading.
- `seq` is a monotonic ordering field; seed it from the clock like the pi
  integration does, so two processes reporting on one pane do not collide.
- Useful CLI equivalents when debugging: `herdr pane list`, `herdr agent list`,
  `herdr pane read <pane_id> --source visible`.

**`openInHerdr` is opt-in, per subagent**, exactly like `lifetime`: a fan-out of
twenty branches must not carpet the screen unless someone asked. The other
regime - **watch everything** - belongs to the reporter, not to the core:
`createHerdrReporter({ all: true })`, seeded by `COMBO_HERDR=all` and
toggled for a session with `/herdr on`. Who gets a pane is a display decision,
and the workflow runs identically either way; putting it on the spawn would have
meant threading a flag through every call site to change what a terminal shows. It travels on
the `spawn` event rather than being read back from the core - a reporter is a
pure observer, it never queries anything.

The split **closes automatically** when the subagent closes, after the final
usage line is written. No orphan panes after a fan-out.

**A reporter that nobody subscribes reports nothing.** `onEvent` takes a single
listener, so watching in the TUI *and* in herdr means composing them - use
`combineReporters(collector.reporter, createHerdrReporter())`, which drops the
`undefined` that `createHerdrReporter` returns outside herdr. The extension once
passed `openInHerdr` all the way to the `spawn` event with nobody listening, and
nothing failed: no split, no error, no clue.

### pi TUI reporter (always available)

Implemented across `src/reporters/tui.ts` and `extension/index.ts`.

**The split that makes it testable.** `tui.ts` *collects* - it turns the event
stream into a `TuiSnapshot` and formats strings, with no pi-tui import. The
extension *draws* - it maps tool arguments onto combinators and builds
components. Collection is therefore tested by inspecting a snapshot, never by
scraping a terminal, and the same state would feed a web view or an export
without touching a component.

The rendering is still tested, though: `test/extension.test.ts` captures the
registered tool, calls `renderCall` / `renderResult` with a full `Theme`, and
reads the component's own `render(width)`. That catches the failure that
actually bites - a renderer that throws makes pi fall back to its default
rendering silently, and nobody notices until the demo.

`Theme.fg` throws on an unknown colour, so a partial stub fails on the first
unusual colour rather than on a real defect: `test/fixtures/theme.ts` builds a
complete one. Do not reach for pi's internal `theme` singleton - it is not
exported from the package root.

The extension registers the tool with `renderCall` / `renderResult` (see
`docs/extensions.md`, *Custom Rendering*) and composes with
`@earendil-works/pi-tui` (`Container`, `Text`, `Markdown`, `Spacer`).

Load it with `pi -e extension` (the flag accepts a directory), or `pi install
./extension` to add it to settings.

Display specification - this is the "Claude Code" bar we are aiming at:

- **A dot per subagent above the prompt**, via `ctx.ui.setWidget(key, lines)`
  (`aboveEditor` is the default placement). `●` while it works, `✓` when it
  succeeded, `✗` when it failed, coloured by status; then a dimmed line with
  model, tokens and time. This is the Claude Code shape, and it is the *live*
  view - the tool row below holds the record.
  - The widget **disappears as soon as the work ends**, in a `finally` so a
    thrown workflow does not leave a dead row of dots above the prompt.
  - `widgetRows()` says *what* each line is and applies no colour, so the layout
    is testable without a terminal; the extension paints it.
  - **Events alone are not enough to keep a clock.** `usage.busyMs` only lands
    when a turn ends, so a widget reading it would show `0.0s` for the whole
    wait and then jump to the total. `SubagentSnapshot.startedAt` gives a live
    figure, and the extension repaints on a 250 ms tick - a subagent thinking
    for twenty seconds emits nothing, and a frozen clock reads as a hung agent.
- **Collapsed tool row, compact, one line per subagent**: status icon
  (`⏳` / `✓` / `✗`), agent name, truncated task, last tool called.
- **Streaming**: you see tool calls arrive, not an opaque spinner. Handle
  `isPartial`, call `context.invalidate()` sparingly.
- **In parallel, everything advances at once**: `2/3 done, 1 running`.
- **Expanded view (`app.tools.expand`)**: full task, all tool calls formatted
  (`$ cmd`, `read ~/path:1-10`, `grep /pat/ in ~/path`), final output rendered as
  **Markdown**, usage per subagent.
- **Usage line**: `3 turns 12.4s ↑12k ↓2.1k R8k $0.0412 ctx:34k model` - and,
  for a persistent agent, the **cumulative** usage since its spawn.
- **End-of-workflow summary**: a table with one line per subagent (time, turns,
  tokens, cost), a total at the bottom, and the export directory path if an
  export was requested.
- Use `keyHint("app.tools.expand", …)` rather than hard-coding "Ctrl+O": the
  user's key configuration must be respected.
- Reuse `context.lastComponent` instead of rebuilding the tree every frame.

## Asking the user, and touching the world

Two ports, one rule: **the agents produce text, our code performs the act.**

- `src/ask.ts` - `AskUser`, one question at a time. The pi implementation is a
  select card (`extension/ask-ui.ts`), an example uses readline, the tests use a
  scripted array. Returning `undefined` is the **submit**, not a cancel: what was
  already answered still counts, and the brief is still written. `esc` maps to it
  for the same reason.
- `src/verify.ts` - `Verify`, a command we run with `execFile` and no shell. Its
  output is evidence the agents read and cannot argue with.
- `src/git.ts` - the git a pipeline may do, as functions. There is no `push`, no
  `reset`, no `rebase`, no `--force`, and no shell: arguments are arrays and the
  commit message is piped to `git commit -F -`, so a message containing
  `rm -rf /` is committed rather than executed.

**Why the committer has no `bash`.** It was the obvious design - give the agent
git and tell it what not to do - and it is exactly what "a prompt is not a
permission boundary" forbids. The agent writes the message, which is what a
model is for; the branch and the commit are ours. Adding a subcommand is a
decision someone takes in a diff, not an argument a model produces at runtime.

**Why the interactive flows are commands, not tools.** A question card owns the
terminal until it is answered, and nobody can answer a question asked inside a
model's turn. `/interview` and `/build` are therefore `pi.registerCommand`, and
`/build` stops exactly twice: the brief before any work starts, the commit before
anything reaches history. A refusal at either stop leaves everything where it is
- the brief in the editor, the work in the working tree. Nothing is undone on the
user's behalf.

## Resuming a build

A delivery is long, it costs money and it writes to a working tree. `deliver`
therefore takes `onProgress` and `resume`, and `src/resume.ts` turns the one
into the other through `runs/<timestamp>/build.json`.

- **Only what was approved survives.** A subtask still being argued over left the
  tree in a state nobody signed off on, so it runs again. Approval is the only
  claim from a previous life worth trusting.
- **The plan is reused, never re-made.** Re-planning would re-split work that is
  already half done on disk, and the plan was paid for.
- **Nothing of the conversation is saved.** Agents are stored by name and
  resolved again; `Result.messages` are dropped. A resumed build re-reads the
  code rather than replaying a transcript - which is also what keeps the file
  small enough to write after every step.
- **A state whose agents no longer exist is refused whole.** Dropping the steps
  that no longer resolve would silently drop work.
- **The audit rounds already spent are spent.** Resuming continues the cycle, it
  does not restart it.
- `onProgress` is a reporting hook, so a listener that throws is swallowed - the
  same rule as the event bus.

## The pi API: what you need to know

**Which pi matters is the one the code runs inside, not the one in
`node_modules`.** An extension is loaded into pi's own process, so it resolves
pi's own copy of the package. Homebrew ships `0.80.6`; npm is on `0.80.10`; and
those two disagree on the model API - `0.80.7` replaced `AuthStorage` +
`ModelRegistry` with a single `ModelRuntime`. A pi "patch" release can break the
API.

`src/session.ts` therefore supports both, choosing by **presence of the export**
rather than by version string: a version number can be patched or mis-set, a
missing export cannot be faked. See `buildRegistry`, which is exported precisely
so the choice is testable.

This is the failure mode to remember: 158 tests were green while the extension
died on `undefined.create()` in a real pi, because every test injects a fake
`SessionPort` and none of them ever touches pi's real module. **A fake session
cannot tell you the package it stands in for has changed shape.** Anything that
only runs against the real pi has to be exercised against the real pi.

Local reference docs: `node_modules/@earendil-works/pi-coding-agent/docs/`
(read `sdk.md`, `extensions.md`, `tui.md`), examples in `examples/sdk/` and
`examples/extensions/` - in particular `examples/extensions/subagent/`, which we
take inspiration from but **do not copy**: it spawns one process per subagent
and therefore has no notion of lifetime.

Creating an isolated session (see `src/session.ts`, the only place the pi API
lives):

```typescript
import { ModelRuntime, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();   // replaces AuthStorage + ModelRegistry

const { session } = await createAgentSession({
  cwd,
  modelRuntime,
  model: resolveCliModel({ cliProvider, cliModel, modelRuntime }).model,
  tools: agent.tools,                       // ["read", "grep", "find", "ls"] …
  resourceLoader: new StaticResourceLoader(agent.systemPrompt),
  sessionManager: SessionManager.inMemory(cwd),
});

await session.prompt(task);
const messages = session.messages;
session.dispose();                          // ← always, in a finally
```

Points to watch:

- Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`
  (default: `read`, `bash`, `edit`, `write`). `noTools: "all"` disables
  everything.
- A read-only subagent is `tools: ["read", "grep", "find", "ls"]`. **That is the
  recommended default** for exploration agents. The allowlist is genuinely
  enforced by pi - verified: a scout session exposes exactly those four tools.
  A weak model will still *emit* calls to tools it does not have (`edit`,
  `run`); they fail, and the model may retry them in a loop. That is an argument
  for `loop`'s `maxIterations`, not for loosening the allowlist.
- **A prompt is not a permission boundary.** `examples/04-loop.ts` used to hand
  the `coder` its full `edit`/`write` toolset and merely *ask* it not to change
  anything. It edited `src/usage.ts` anyway, twice, in a plain demo run. If a
  subagent must not write, take `write` and `edit` away from it - do not ask it
  nicely. This applies with force to anything shipped in the repository: an
  example must not be able to rewrite the repository it ships in.
- The system prompt goes through the `resourceLoader`, **not** through a
  `systemPrompt` field on `createAgentSession`. We supply our own
  (`StaticResourceLoader`): `DefaultResourceLoader` requires `cwd` and
  `agentDir`, re-reads the disk on every spawn, and loads extensions, skills and
  project trust - non-deterministic context a subagent does not need.
- **`session.prompt()` does not accept an `AbortSignal`.** `PromptOptions` only
  holds `expandPromptTemplates`, `images`, `streamingBehavior`, `source`,
  `preflightResult`. Cancellation goes through `session.abort()`: we bridge the
  signal by hand, and remove the listener after each turn.
- Messages are read from `session.messages`; `session.agent.state.messages` is an
  internal detail.
- A turn can fail **without throwing**: look at the last assistant message's
  `stopReason` (`"error"`, `"aborted"`).
- **Not every provider reports tokens.** Several return a `usage` that is already
  zero at the source; `getSessionStats()` then sums zeros. We display `0`, we
  never estimate it. (Verified: `local/*` reports tokens, `opencode-go/*` and
  `ilaas/*` do not.)
- `session.subscribe(…)` is the source of every `SubagentEvent`:
  `message_update`/`text_delta`, `tool_execution_start`, `turn_end`,
  `agent_end`. Never log directly from the core.
- `session.prompt()` in series on one session **is** a persistent subagent. That
  is literally the whole implementation of `lifetime: "workflow"`.
- `session.compact()` exists: it is the way out for a persistent agent whose
  context is swelling.
- Measurements and export are `AgentSession` methods: `getSessionStats()`,
  `getContextUsage()`, `exportToHtml()`, `exportToJsonl()`. **Call them before
  `dispose()`.**
- `session.dispose()` releases the session; an undisposed session leaks.

## Defining an agent

Markdown + frontmatter, compatible with pi's convention
(`~/.pi/agent/agents/*.md`, `.pi/agents/*.md`):

```markdown
---
name: reviewer
description: Reviews code and returns actionable remarks
tools: read, grep, find, ls
model: anthropic/claude-sonnet-5
lifetime: workflow          # our own extension: default lifetime
---

You review the code produced and return at most 5 remarks…
```

- `name` and `description` are **mandatory**; a file without them is ignored
  silently (pi's behaviour, we keep it).
- `lifetime` and `openInHerdr` in the frontmatter are only **defaults**: an
  explicit call always wins. Declaring `openInHerdr: true` on an agent is often
  what you want - a scout is worth watching whoever calls it.
- Project agents (`.pi/agents/`) are **repository-controlled** content: loaded
  only on explicit request (`scope: "project" | "both"`), never by default. Do
  not relax that rule "to keep things simple". This repository's own demo agents
  live in `agents/` and are symlinked into `.pi/agents/`, so the extension can
  find them - with an explicit scope, like anyone else's.
- **An empty agent list is almost always a scope problem, not a typo**, so
  `findAgent` says so. Given the old "Loaded agents: none", a model concluded the
  repository had no agent definitions at all and started offering to write some.
  An error message is read by an LLM as often as by a human now; it has to name
  the real cause.
- Agents are rediscovered on every call (hot editing works).

