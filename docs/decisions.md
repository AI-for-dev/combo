# Design decisions

Why combo is shaped the way it is, and what was reversed along the way.
This page records **decisions**, not the state of the code: read the relevant
section before undoing a design choice, and add to it when you take one.

`AGENTS.md`, at the root of the repository, holds the short version - the
invariants an agent must not violate. The rest of [docs/](index.md) explains how
to use what these decisions produced.

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

### Reading what a model wrote lives in one file

`src/text.ts` holds `truncate`, `firstLine`, `scalar`, `saysWord` and
`jsonObjects`: everything that turns free-form assistant text into something a
workflow can act on. Only `truncate` is on the public surface, because the
extension needs it and an extension imports from `src/index.ts`, never from an
internal file.

**This reverses a decision.** `interview.ts` carried a comment saying its brace
scanner was kept apart from `plan.ts`'s on purpose, since "merging them would
mean a generic find-me-some-JSON utility that neither caller could read". The two
had since become character-identical, and what they share is only the **scan** -
each caller still keeps its own filter (`readStep`, the question reader), which
is where the readability actually lives. The same held for the `LGTM` /
`APPROVED` / `READY` matcher, written three times, and for `truncate`, written
five times and already drifting: one copy trimmed, one did not.

The rule that survives is the one that made the original call defensible: **a
shared helper takes the part that is identical, never the part that is
interpretation.**

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
`createHerdrReporter({ all: true })`, toggled for a session with `/herdr on`.
It was also seeded by a `COMBO_HERDR` environment variable, which is gone: the
same rule that removed `COMBO_MODEL` applies to display. Configuration is an
argument or a command, never ambient state. Who gets a pane is a display decision,
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

### The stream on disk

`recordReporter(file)` appends every event as one JSON line. It is a reporter
like the others - the run is identical without it - and it earns its place
because pi's per-subagent JSONL cannot show the **interleaving**, nor carry a
timestamp pi does not have.

- **Verbatim, no filtering, no knob.** A recorder that edits its own record is
  worse than a large file, and the question it will be asked is the one nobody
  planned in advance.
- **`appendFileSync`, not a write stream.** One syscall per event is the cost;
  the run worth reading afterwards is the interrupted one, and a buffered stream
  loses its tail exactly then. Same trade as the export.
- **Every experiment cell gets one**, at `events.jsonl`, with no option to turn
  it off. A cell whose stream was not kept can only be re-run, and a matrix is
  expensive. The day someone needs it off is the day the knob is justified.

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

## The model: an explicit knob at every level

For a long time the model was the one thing invariant 5 did not cover, and it
was measured: agents with no `model:` ran on the operator's
`~/.pi/agent/settings.json` defaults (`cerebras/gemma-4-31b`, 402s inside a
session started with `--provider test-ilaas`, `thinkingLevel: high` nobody
asked for), while the caller's `--provider`/`--model` never reached a
subagent. An experiment that pinned its repository with a tag while leaving
the model floating was measuring the operator.

The fix is **one option, `model`, at every level, with the nearest override
winning** - the same "an explicit call wins" rule as `lifetime`:

1. the run-time argument: `SpawnOptions.model`, `WorkflowOptions.model`, the
   tool's `model` param, `--model` on `/run` and `/build`;
2. the pipeline file's top-level `model:`;
3. the agent's frontmatter `model:`;
4. pi's own settings, as the last resort - only when nothing was set anywhere.

It is an **override, not a default**: the knob exists to run one workflow
against different LLMs, and a frontmatter model surviving a sweep would make
the experiment measure a mixture. Precedence is resolved once, in `spawn()`,
so an injected fake session observes the *effective* pattern.
### What a shipped agent declares: nothing

None of the nine agents in `agents/` carries a `model:`, and that is a decision
rather than an omission. A definition that ships in a package must not choose its
user's provider: pinning one would override the settings they already made and
break outright for anyone holding no key for it. So a shipped agent falls through
to step 4, which is what makes `pi -e extension` work on a machine we know
nothing about.

The cost is real and worth stating, because it is invisible: **a run with no
`--model` measures the operator.** Verified on 2026-08-01 - `/run explore` with
nothing specified put all four subagents on `ilaas/gemma-4-31b`, a model named
nowhere in this repository, read from `~/.pi/agent/settings.json`. An earlier run
picked up a `thinkingLevel: high` nobody asked for the same way.

Which is why the fix is a habit, not a file: **anything whose numbers will be
compared names its model.** `experiment()` takes `models` and refuses to guess,
`--model` exists on `/run` and `/build`, the examples take it in argv, and a
pipeline that belongs to one repository may pin its own. An agent *you* write for
*your* machine is welcome to declare one - it is only what ships that must not.

Three deliberate refusals, so nobody "fixes" them later:

- **No environment variable is read by the library, or anywhere else.** An
  ambient variable is how this hole existed; the examples take `--model` in
  argv instead, and the old `COMBO_MODEL` is gone.
- **The parent session's model is never inherited** by a subagent, even though
  the extension can see it. A subagent floating with whatever the operator's
  TUI happens to be on is the same bug one level up. The model comes from an
  explicit artifact - an argument or a file.
- **No per-step pipeline `model:`** until a real pipeline needs one: agent
  frontmatter already covers "this role runs on X".

An unresolvable pattern still throws at spawn (a workflow on the wrong model
costs more than a lost run). The commands validate `--model` with
`checkModel()` **before** the interview, in the same early block as
`checkPipelineAgents` - a typo costs a second, not a conversation. Like
`buildRegistry`, `checkModel` touches the real pi module: only a run inside a
real pi proves it end to end.


## Experiments: comparing models on the same work

The model knob only pays off when something uses it to compare. `experiment` is
that something: M models × N repetitions of one workflow, each cell in its own
directory with its own measurements, and one table at the end.

It is **a function, not a combinator**. It returns no `Result` and composes with
nothing, because it is a harness placed above a workflow - one that could be
nested inside a workflow would be measuring itself. Everything else here is
nestable on purpose; this one is deliberately not. It is also not a pipeline
kind: a pipeline is data a model must not be able to author, and a matrix over
models is code the operator writes.

A cell is handed a ready-made `WorkflowOptions` and the contract is to **spread
it**. That is what puts every subagent on the cell's model, in the cell's export
directory, and under the cell's collector - a callback that rebuilds those by
hand silently measures something else. It is also why pipelines need no support
of their own: `PipelineRunOptions` extends `WorkflowOptions`, so `run: (cell) =>
runPipeline({ ...cell.options, … })` is the whole integration.

Three rules the arithmetic depends on:

- **Sequential by default.** `concurrency` is 1 unless asked otherwise: two
  cells racing for the same machine measure the contention, not the models.
- **Sums are stored, means are displayed.** `experiment.json` carries totals
  only; the mean wall and mean cost are derived when the table is rendered.
  Averaging averages is how a study starts lying about itself.
- **A failed cell stays in the report, with its usage** - a callback that threw
  included. It spent tokens before it broke, and dropping it would turn "two
  models out of three answered" into a clean comparison of the survivors. Same
  reason `loop` reports `converged` apart from `ok`.

Flag columns are the union of the outcome keys actually seen, so a study
comparing `converged` gets a `converged` column with nothing configured. `error`
never becomes one: a column of distinct sentences compares nothing.

## The public surface: one entry point, grouped as it is learnt

`src/index.ts` is the only door - the examples and the extension import from it,
never from a file inside `src/`. What changed is that it is now **grouped the way
the library is learnt** rather than alphabetically: start here (an agent, a run, a
result), the combinators, watching a run, measuring a run, pipelines, the ports
that touch the world, the pi session. A reader who needs a dozen symbols finds
them in the first section instead of scanning ninety.

Two rules decide whether a symbol belongs on that list at all:

- **A type named by a public option or return value is public.** `HerdrSend` is
  `HerdrOptions.send`, `HerdrEnv` is what `detectHerdr` returns, `CreateSession`
  is `SpawnOptions.createSession` - remove any of them and the option cannot be
  written from outside. This is why the option and result types of every
  combinator stay, even though nothing in this repository names them.
- **Test-only is a reason to stay off it.** Tests reach into `src/` directly, so a
  helper exported for one is not part of the surface. Eleven symbols left on that
  basis: the package's own directory constants (`PACKAGE_ROOT`,
  `BUILTIN_AGENTS_DIR`, `BUILTIN_PIPELINES_DIR`), the herdr transport under
  `detectHerdr` (`createHerdrSend`, `HERDR_SOURCE`), the leaf formatters
  `widgetRows` already composes (`currentActivity`, `detailLine`, `elapsedMs`,
  `widgetLines`) and the id counters (`nextSubagentId`, `resetSubagentIds`).

Both rules are stated at the top of the file, because the next person adding an
export will read that before they read this.

## A default is written after the spread, never before

`pair` and `interview` default their lifetime to `"workflow"` - two agents in a
conversation keep their memory unless the caller says otherwise. That default
used to be written as `{ lifetime: "workflow", ...options }`, which is correct
for a caller that types its options by hand and wrong for every caller that
builds them by merging.

`runPipeline` is such a caller. It laid a step's overrides on top of the run's
options with `lifetime: step.lifetime ?? workflow.lifetime`, and when neither
was set the key still existed, holding `undefined`. Spread over the default,
that `undefined` won: the same `deliver`, run from code, gave its pair one
worker and one reviewer for the whole conversation; run from a pipeline file, it
gave them a fresh pair every round. A reviewer that never remembers its own
remarks is not a detail, and nothing in the output said so - the run simply cost
several times more turns.

Two rules came out of it, and both are now tests. **A default belongs after the
spread**, as `options.x ?? default`, so that an explicit `undefined` reads as
"nobody set this" rather than as a choice. And **a merge must not invent keys**:
`override()` in `pipeline-run.ts` copies an override only when it is defined,
because `{ lifetime: undefined }` and `{}` are the same intent and must become
the same object.

The general form is worth stating, since the next merging caller will be a new
extension command: in this codebase, absent and `undefined` mean the same thing,
and any code that turns the first into the second is a bug even when the types
allow it.

## The pages, split into a guide and a reference

Eleven hand-written pages sat in one flat directory next to the generated
`docs/api/`. They are now `docs/guide/` - task by task, in the order the library
is learnt - and `docs/reference/`, holding the generated API beside the list of
examples. `index.md`, `development.md` and `decisions.md` stay at the root: they
are the way in and the two pages about the repository rather than about using it.

The split is the question a reader arrives with. *How do I make two agents argue
until they agree* and *what does `fanOut` take* are different questions, and a
flat directory answered neither first - it offered fourteen file names, sorted
alphabetically, of which the second was `build.md` and the third `decisions.md`.

`scripts/api-docs.ts` computes its links out of `DOCS_DIR` instead of spelling
them, so the two that leave the generated tree - the design decisions and the
README - follow the next move on their own. That was the actual cost of this one:
the pages moved with `git mv` in a second, and the links took the afternoon.

## The documentation, as a site

The pages were always Markdown in `docs/`, read on GitHub and in the published
tarball. They are now also a Sphinx site - MyST Markdown, the furo theme, built
by `make -C docs html` with `-W`, so a warning fails the build exactly as a
failing test does.

**Sphinx over the same files, not a second copy.** Nothing was written twice: the
site renders the pages that were already there, and the only Sphinx-specific
syntax in them is the toctrees and the cards on the landing page. A page that
reads well in a repository and badly on a site is a page with two audiences and
one author; this way there is one file per subject, whatever is reading it.

**Python is a documentation dependency, and says so.** It lives in
`docs/requirements.txt`, never in `package.json`. `npm test` and `npm run
typecheck` do not reach the directory, and the library still depends on the pi
SDK alone - which is the rule that made this worth stating rather than assuming.

**`guide/` and `reference/`.** Task-oriented pages moved under `guide/`, and the
generated API under `reference/api/` beside `reference/examples.md`. The split is
the question a reader arrives with: *how do I do this* has a different shape from
*what does this export do*, and eleven pages in a flat directory answered neither
first. `scripts/api-docs.ts` computes the links out of `DOCS_DIR` rather than
spelling them, so the next move is one constant.

**The toctrees are the navigation, and the only one.** `docs.json` listed every
page for `test/docs.test.ts` to check reachability; Sphinx needs the same list as
`toctree` entries, and two lists of the same pages disagree the day someone edits
one. The JSON went, and `scripts/doc-links.ts` reads the toctrees instead - so
the offline suite still fails in seconds on a page nobody can reach, and it fails
on the list the site actually uses.

**What `-W` caught on the first build**, and neither the suite nor a reader
would have: ninety-three code blocks that failed to highlight, because `{ … }`
is not TypeScript a lexer accepts, and a dead link at the top of every generated
page. The first is why a signature now elides with `{ /* … */ }` - a comment, so
the block stays lexable - and why a long initialiser keeps its last line: the
bracket it closes. The second is why "Source:" is an absolute URL into the
repository rather than `../../../src/<module>.ts`: that path resolves in a
checkout and in the tarball, and is dead on a site that publishes `docs/` alone.
It is read from `package.json`, so the repository is named once.

**The site is built in CI, and published from `main` alone.**
`.github/workflows/docs.yml` is the first workflow this repository has had, and
it exists because `-W` is only a standard if something enforces it: a build that
runs on one laptop is a build that breaks quietly. Every pull request builds the
site; only `main` deploys it to GitHub Pages. The workflow also regenerates
`docs/reference/api/` and diffs the result, because the site publishes what is
committed - and a reference that no longer matches the source is exactly the
failure the generator was written to prevent, arriving by a different door.

### The type

Three faces, one job each: **EB Garamond** for what is read, **Inter** for what is
navigated - headings, sidebar, tables, cards - and the reader's own monospace for
what is typed. The third is not shipped on purpose: code is read in the face
someone has already chosen for code, and a page that overrides it is arguing
about the wrong thing.

The other two **are** shipped, and that is the decision. A font CDN would tell a
third party who reads this documentation and would leave every page waiting on a
host nobody here controls; system stacks cost nothing and give a different page on
every machine. So the files live in the repository, cut down to the characters
these pages use by `scripts/subset-fonts.py`, from a pinned commit of
`google/fonts` - never `main`, which moves - with the OFL text beside them, as
that licence requires.

**Static instances, not variable.** Measured, subset the same way: variable was
480 kB for three files, static 272 kB for five. A variable font pays for every
weight between 400 and 800 whether or not a stylesheet asks for one, and this one
asks for four weights in total.

**A subset is a silent failure waiting to happen.** A character no shipped face
carries is drawn from whatever the reader has installed - different weight,
different baseline, and visible to them alone. So the script writes
`coverage.json` from the cmap of the files it actually produced, and
`test/fonts.test.ts` fails on a page whose prose needs more. The serif stack also
names Inter before any system face, so a character only one of the two carries
still lands in a face this site ships.

Two details the faces themselves forced. EB Garamond is a sixteenth-century
design with a small x-height, so `article` sets its own size rather than furo's -
16px of it reads a size smaller than 16px of anything drawn for a screen, and
raising the root size would have shrunk nothing but grown the entire chrome. And
its figures are old-style, which is right in a sentence and wrong in a column, so
tables ask for lining and tabular ones.

### The mark

combo had no drawing of its own. It has one now: **three strokes in, one out** -
the three identical and in the ink, because a fan-out has no favourite branch,
and the one leaving in verdigris, because a workflow is judged on what it
returns. `docs/_static/logo/README.md` holds the palette, the file table and the
two rules that are easy to get wrong: a two-tone drawing needs a file per ground,
and `currentColor` never reaches an SVG referenced as an image.

**The wordmark is geometry, not type.** Circles on a 20-unit x-height at one
stroke width, rather than glyphs outlined from a font. Outlining is the usual
answer, and it costs a vendored typeface, a licence to check and a generator to
run before the lockup can be rebuilt. Drawing it costs a paragraph of
construction notes - and, like an outlined wordmark and unlike a `font-family`,
it cannot fall back silently on a reader who lacks the face.

The neutrals are [trysquare](https://github.com/AI-for-dev/trysquare)'s, and the
site is shaped like its documentation, deliberately: two tools by the same hand,
meant to be read together, cost a reader more when they look unrelated than they
gain by being distinct. What differs is the accent - brass there, verdigris here.
