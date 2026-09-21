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

### A turn is the pool's interface

`SubagentPool` used to hand out subagents: `acquire`, `release`, `closeAll`.
Every combinator then wrote the same six lines around them - check the signal,
acquire under a key, `try`, `ask(task, { signal, timeoutMs })`, `finally`
release - ten times over, and the pool's constructor, which absorbed eight of
the shared options, dropped the two that a turn needs. Twenty-four call sites
threaded `signal` and `timeoutMs` by hand, and the file holding the pool had no
test of its own: the only proof that a deadline reached a turn was one
assertion per combinator, each testing the same thing.

The pool now plays the turn. `turn(agent, task, { key })` is the whole of the
sequence: it refuses without spawning on a signal already aborted, runs the turn
with the workflow's signal and deadline, and gives the subagent back in a
`finally`. `hold(agent, { key })` is the other shape a combinator needs - a
conversation of several turns, for the interviewer and for a swarm's members -
and it returns an `id` and an `ask`, not the `Subagent`: closing stays the
pool's job, so nothing a combinator receives can be forgotten. `release` is
private. What was `common.ts` is three files, one concept each: `options.ts`,
`pool.ts`, `concurrent.ts`.

Two abort checks survive outside the pool, and both are about what happens
*before* a turn: `pair` would otherwise make a working copy for a pair that will
never run in it, and `interview` would spawn a held interviewer it never asks.

The tests moved with the behaviour: the pool's contract - lifetime by key, the
options on every turn, refusal without a spawn, release on a throw, `closeAll`
surviving a close that fails - is asserted once in `test/pool.test.ts`, and the
per-combinator assertions that each proved a forwarded `timeoutMs` are gone. A
combinator's tests now say what the combinator decides, not what it relays.

### The trail is the pool's too

Playing the turns left each combinator keeping what the turns added up to. Six
of them held a `steps` array they pushed every turn into, seven kept a
`performance.now()` of their own, five wrote the same `sumUsage(steps, now -
startedAt)`, three derived `ok` and `error` from the first failed step, and two
wrapped their progress hook in the same seven-line `try`/`catch`. None of that
was the combinator's to decide, and one of the copies had a hole: `turn`
refused a signal already aborted before spawning, `hold` did not, so `swarm`
held its whole roster and only then looked at the signal - a swarm called off
before it started spawned every member. No swarm test said so; the other eight
combinators each had a cancellation test.

`Trail` (`src/workflows/trail.ts`) is the envelope, written once: the results
recorded in order, a clock opened when the trail is, `usage()` over that clock,
`broken()` for the first failure. The pool owns one and records every turn on
it - a refused turn included, because a chain that was called off should say so
where the answer would have been. A combinator reads `pool.trail.steps` and
`pool.trail.usage()` and keeps nothing beside them. `hold` refuses the way
`turn` does: a held subagent is spawned before it is asked anything, so the
check on its first `ask` would have come after the session it was meant to
spare. A refused hold is addressed by its key, since there is no subagent to be
named after, and every `ask` of it answers the refusal.

The trail is the pool's second constructor argument rather than a member the
pool creates, for two callers: `pair` opens its trail before its working copy,
because the time the copy takes is part of what the pair took, and its pool
cannot exist until the copy does; `orchestrate` has no pool of its own - the
planner's, the branches' and the reducer's are three - and records the three
workflows' results on one trail. Making the trail members of the pool would have
left both keeping their own again.

Of the two abort checks that survived outside the pool, `interview`'s went with
`hold` refusing. `pair`'s stays, for the working copy. `audit` checks before the
turn too, for a different reason: a refused turn would be recorded as an audit
round that never ran. `swarm` still reads the signal between rounds, because
that is where `stoppedBy: "signal"` is decided. `deliver` keeps its own sum: its
usage is the build's, kept tasks and recorded audits of a resumed run included,
and that is a property of the build's progress rather than of the turns this run
played.

The progress hooks go through `notify` in `events.ts`, the same swallow the bus
gives every reporter: a hook is an observer, and a throwing observer has never
been the workflow's problem.

The tests moved with the behaviour. The trail's arithmetic is asserted once in
`test/trail.test.ts` and its place in the pool - every turn recorded, held turns
too, refusals too, a refused hold without a spawn - in `test/pool.test.ts`. The
usage sums `pair` and `interview` each proved through their own outcome are
gone; `orchestrate`'s stays, because what it records on its trail is its own
decision. `swarm` has the cancellation test it was owed.

### Every workflow is a Result

`WorkflowResult` was the contract five combinators honoured - `chain`, `loop`,
`reduce`, `route`, `pair` - and six did not: `fanOut`, `orchestrate`,
`deliver`, `interview`, `swarm` and `audit` each returned a shape of their own,
`usage` and `ok` included but no `output`, no `agent`, no `steps`. The two
places that read every combinator recoupled the gap by hand and did not agree.
The pipeline runner made a `Result` out of a fan-out by taking the first failed
branch or the last one and replacing its output with every branch's joined,
made one out of an orchestration by naming the planner and copying its
messages, made a third out of a delivery the same way; the `subagent` tool
read an orchestration's `planning` when nothing else was there. A fix to what
a fan-out amounts to reached one of the two.

The reading now lives with the combinator, and both callers do the same thing
for every kind: keep the result as it came. A fan-out speaks through the branch
that failed, or the last one, with every branch's output labelled where its own
would be; an orchestration through its synthesis when it has one and its
planner otherwise; a delivery through its planner, over every subtask's report;
an interview through its last turn, whose output is the brief; a swarm through
the member that failed or the last on the roster, each member's last word
labelled by the name it posted under; an audit through its last review. `ok`
keeps its one meaning, every turn ran, and what a workflow says beyond that
stays in a field of its own - `approved`, `converged`, `plan` - which is why a
`deliver` step keeps the whole delivery beside its `Result` rather than folding
`approved` into `ok`.

`joinOutputs` moved from the runner into `result.ts` and learnt to mark a
failure: the runner's copy printed a failed branch as a heading over nothing,
and a step reading six sections when eight ran would take the silence for
completeness. The runner also records each step's result on a `Trail`, so its
usage is the trail's rather than a sum kept by hand. One pipeline rule stays in
the runner because it is the pipeline's: a `loop` that never converged fails
its step, since handing unconverged work to the next step is the silent failure
`converged` exists to expose.

`FanOutResult.results` survives beside `steps`, the same list under two names,
because `results` is what every reader of a fan-out already calls its branches
in task order and `steps` is what the contract calls them. `InterviewResult.brief`
survives beside `output` for the same reason. Two aliases were judged cheaper
than a rename through every caller and every page.

### One shape for where a build stands

"What a delivery has done so far" was spelled four ways: `AuditProgress` from
the audit cycle, `BuildProgress` for the hook and the resume, `BuildState` on
disk, and `DeliverResult` at the end. `deliver` held a fifth in four `let`s,
filled by a `take()` that copied the audit's progress field by field so that
`report()` could rebuild a `BuildProgress` and `outcome()` a `DeliverResult`.
The disk had drifted from the rest: a saved audit kept the review's text, its
`ok`, `approved` and the fixes, and dropped the verdict, the check as it stood
and what the fixes produced, so a resumed cycle read a thinner history than the
one it had lived; and the review came back as a `Result` with `agent:
"auditor"` written in, whatever the auditor was called.

`BuildProgress` is now `AuditProgress & { plan }`, defined by `deliver`, which
is the workflow that reports it - `resume.ts` imports it rather than the other
way round. `DeliverResult` is that progress as it ended, plus what only the end
can say: the brief, the planning turn, the landings, `approved`, and the
`Result` reading. `deliver` keeps one `progress` and moves it forward by spread:
the plan once made, the tasks and the check once settled, and after every
audit round whatever the cycle reports - which is why `AuditResult` now carries
its cycle under `progress`, the same shape every round reported, so a caller
absorbs the end of the cycle in the same spread as its rounds. `take()` and the
four variables are gone.

`done` left the progress. A build's progress does not know whether the build is
over; the moment it is reported does. So `onProgress(progress, done)` says both,
`toBuildState` takes `done` with the rest of what the state says about the
build, and a `resume` no longer carries a `done` nobody read. `notify` grew
variadic for it, which costs the bus nothing.

The saved round keeps what the live round has: the auditor's name, the review's
usage and error, its verdict, the check that stood, and the fixes' results as
saved tasks. `BUILD_STATE_VERSION` is 2, because that is what the version is
for: an older file is refused whole rather than read into a shape it does not
fill. The two conversions are written once each, `saveTask` and `loadTask`,
shared by the subtasks and the fixes. What a state still drops is the trail -
messages, turns, the review a pair kept, the working copy - and the test that
proves it is now an identity: a full progress through `toBuildState` and back
is itself, less that trail.

### The record states its own terms

The record joined the verdict to the ledger, and both callers still did the
same three things around it. They built it alike, reading `declaresVerdict` off
the agent and wrapping `saysWord` in a one-line predicate each, with its own
constant. They wrote the same ternary to offer the tool - `record.tool ? … :
…`, cast included - one to the reviewer alone, one to the auditor. And they
handed `byTool` and `open` back out to their prompt, where `reviewPrompt` and
`auditPrompt` each rendered "Still open, from your earlier rounds:" over
`openList` and the same fork between calling the tool and answering the word
alone. `auditPrompt` had grown to seven positional parameters carrying it.
The record was deep on reading a round and shallow on asking for one, which is
why its interface exposed `byTool`, `open` and `tool` raw.

`reviewRecord(reviewer, { word, approved?, restored? })` now takes the agent
and the word. Whether it decides by tool is read off the agent here, and a
caller's own `approved` stands in for the tool and the word alike, because the
caller's rule is the nearer one. Two things it renders itself. `terms()` is
what every round ends on: the open lines by id, then the instruction - a call
to the tool, with the `resolved` sentence when anything is owed, or the word
alone. `offer(others)` is what goes through `customTools`: the tool to this
reviewer and nobody else, `others` to everyone else, `others` untouched when
the reviewer decides in prose. The prompts take `terms` as a string, so they
stay functions of data: `reviewPrompt(goal, work, round, terms)` and
`auditPrompt({ brief, tasks, round, maxAuditRounds, verification, workers,
terms, byTool })`, the latter keeping `byTool` because the fix lines go where
the decision goes.

Two changes of behaviour rode along, both towards the rule that an agent gets
what its file names. A pair whose reviewer held the tool offered its worker
nothing, dropping whatever the caller had passed in `customTools`; and the
audit's pool dropped the caller's `customTools` whatever the auditor held. Both
now pass `others` through. The prose instruction reads "Answer WORD alone when
you have nothing left to ask for" for the auditor as for the reviewer; what
differed between them was wording, not meaning.

The rules of the ledger are asserted once, in `test/review.test.ts`, where the
terms and the offer are too. The pair's "an obligation a round does not name
stays open" and the audit's "a yes over an open obligation does not approve"
each proved a record rule through a workflow, and are gone; what the two
workflows still assert is that the terms reach their prompt.

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

### Writing for a model lives in one place too

The other direction had the same history. "Several results, laid out for a
reader" was written six times - the tool's answer, the runner's join, the
delegate's report, `reduce`'s branches, the audit's reports, the swarm's
answer - with four heading grammars (numbered or not, `(failed)` or `- failed`,
one blank line after the heading or none) and three spellings of nothing
(`unknown error`, `(nothing)`, `(no output)`). Whoever compared a `/run`
answer with a tool result read two conventions for one fact. Beside it, four
truncations with a marker, two identical but for a word; `plural` written and
then walked past at four sites, one of them in a file that imported it; and
the list of lifetimes kept in three places, each checking it its own way.

`joinOutputs(results, { numbered?, note? })` in `result.ts` is the one layout:
a heading naming the agent, numbered when the caller says so, a note in
parentheses that defaults to `failed` on a failure, a blank line, then the
output or `(no output)` or the error. The two knobs are the two things the six
sites varied for a reason - a reducer refers to branches by number, an audit
says what a review made of each part - and nothing else was. The swarm's
answer labels by member id through `membersOutput`, shared with the swarm's own
`Result`. `head` and `tail` in `text.ts` are the two cuts, one for what goes
into a prompt and one for a check's output, and `git.ts`, `worktree.ts` and
`verify.ts` call them. The four counts go through `plural`. `pipeline.ts`
reads `LIFETIMES` from `agent.ts`, so the tool's schema, the definition parser
and the pipeline parser name the same three words.

Two visible changes rode along. Every heading is followed by a blank line, as
Markdown wants, where the tool and the delegate had none; and an audit's failed
report says `(failed)` beside the name with the error where the output would
be, as every other failed section does, rather than `(failed: error)` over
`(no output)`.

### A result is built in one place, and a double is built whole

`failed()` had six callers and no pendant: the six-field literal of a turn that
ran was spelled out in the core twice, in a workflow, in a resume and three
times in the fake, each free to drift - the close event's `Result` carried
`messages: []` and a cumulative usage, a shape no `ask` returns, and nothing
said so. `succeeded(agent, output, usage?, messages?)` is the pendant, and the
six sites call it. A failed review or a failed fake turn that has text keeps
it, by spreading `output` over `failed(…)`, because that text is the evidence.

The `spawn` event was constructed field by field in the core and in three test
files, each with its own launch counter; when `order` and `parentId` were
added, all four moved. The core keeps its one, since it is where the event is
born; the reporters' test now derives its two events from `test/fixtures/
picture.ts`, which is where the other tests already took them from.

The tests of `/build` and `/run` fed `runPipeline` and `interview` doubles a
corner of what the real thing returns, and cast the rest away: forty-nine
`as never` in two files, and a test author who had to know which corner a
command reads. `test/fixtures/results.ts` builds an `InterviewResult`, a
`DeliverResult` and a `PipelineRunResult` whole, from the few fields a test
cares about, the way `fixtures/picture.ts` builds a snapshot. The casts are
gone, and a double that stops matching the real shape now fails to compile
rather than passing on a lie.

### An offer of tools composes, and a combo tool shares its constant parts

`SpawnOptions.customTools` is a list or a function of the id to come, and
`WorkflowOptions.customTools` a function of the agent answering either. Adding
a tool to what a caller offered therefore needed a flattener, and the only one
in the tree lived in a test fixture. `swarm` did it with a cast -
`options.customTools?.(agent) as never[]` - which read a caller's offer as a
list whatever it was: an offer written in the function form, as the `subagent`
tool writes its own, would have thrown the moment it was spread. Latent only
because `/swarm` passed no offer.

`toolsOffered(offer, id)` in `subagent.ts` is the one reader of the two shapes:
`spawn` reads through it, the fixture is a one-line caller of it, and so is the
composition. `ToolOffer` names what a workflow offers each of its agents, and
`offerBoth(first, second)` is two of them as one, asked for the id whenever
either needs it. `swarm` offers the board beside the caller's offer with no
cast. The two shapes stay: a list is what most callers write, and a function is
what a tool that must know its holder needs, and the reader is what makes the
union safe to hold.

Around each combo tool the same three helpers were written: whether an agent
declares it, an answer, a refusal - one body three times, and two of them
inline in the verdict tool's body. They are `src/tool.ts`: `declares(tools,
name)`, `said(text)`, `refuse(text)`, with `declaresVerdict`, `declaresBoard`
and `declaresDelegate` kept as the named one-liners the extension reads. A
tool body is now the decision it records or the act it performs.

### A verdict is a tool call, and prose is the argument for it

A reviewer's answer carries two things: an argument, which is prose and belongs
in the transcript, and a decision, which is a boolean and does not. `saysWord`
recovers the second from the first, and how well it does that depends entirely
on the agreement about how to write the word. `includes` accepted "I cannot say
LGTM yet" as an approval; the whole-line rule that replaced it rejects that one
and still rests on a convention a model is free to miss.

So a reviewer whose `tools:` names `verdict` is handed that tool, and its call is
the decision. `pair` reads the collector behind the tool, never the text beside
it.

Three options were weighed.

**Keep parsing prose, more carefully.** No new machinery, and the ceiling is the
convention: every refinement buys one more phrasing and leaves the next one.

**Ask for structured output**, a JSON object read by `jsonObjects`. Cheaper than
a tool, and it still arrives inside the prose channel, so "the model wrote
something that parses" and "the model decided" stay the same event.

**A tool call**, which is what was taken. It is a discrete event with a schema,
on its own channel, so *did it decide* and *what did it decide* are separate
closed questions. It costs the `customTools` seam in `src/session.ts` and one
file, `src/review/verdict.ts`.

Three consequences worth stating plainly.

A reviewer that holds the tool and calls nothing has **not** approved, and
`PairResult.verdict` is absent rather than `false`: a turn that failed to answer
is not a refusal, and guessing which one it was from the prose is the reading
this tool exists to retire.

**The tool takes the decision and leaves the argument where it was.** What the
worker receives between rounds is the reviewer's prose, not `verdict.remarks`:
an agent's definition disciplines its prose, and a field the model fills a second
time says the same thing worse. `remarks` is the short form attached to the
decision, and it is what an obligation will be opened from.

And the word survives for every reviewer that holds no tool, because an agent
nobody offered one to still has to be able to say yes.

None of this makes a model's judgement deterministic. It makes reading that
judgement deterministic, which is the only part of it that was ever ours.

### A decision is not lost to the bookkeeping beside it

Reversed, and the measurement is what reversed it. The verdict tool used to
refuse the whole call when `resolved` named an id nothing had raised, on the
grounds that a closure the ledger would refuse is better refused where the agent
is told and can call again. Told, the agent called again with the same invented
id, was refused again, and answered `APPROVED` in prose that nothing reads. The
delivery ended unapproved with no fix raised and no reason a user could see,
over an id that closed nothing either way.

So an unknown id is dropped from the verdict and named back in the same result,
beside `Recorded: approved.` The ledger is exactly as honest as before - an id
nobody raised closes nothing, here or in `ledger.close` - and what changes is
that the decision the call carried survives the mistake sitting next to it.

The refusal that stays is the one about the decision itself: `approved: false`
with no remarks and nothing raised is still refused, because there the missing
part *is* the answer.

### Finished is a ledger, not an opinion

Measured on the run that shipped the verdict tool: the reviewer called `verdict`
correctly and approved a function that computes `a - b` while claiming to add. A
clean channel does nothing about a wrong judgement, so `approved` stops being
what the reviewer said.

Everything a reviewer raises becomes an **obligation** in
`src/review/ledger.ts`, with an id combo assigns and that never changes.
Finished means the reviewer has nothing further to ask *and* nothing it raised
is still open.

The ledger belongs to this code rather than to the agent. Asking a reviewer to
re-emit its remarks each round puts us back to matching one round's prose against
another's, where "is this the same remark as last time" is a guess. A round is
handed the open ids and answers a closed question per id.

Three rules, in code rather than in a prompt:

- **Only whoever raised an obligation may close it.** A worker cannot declare its
  own work accepted, and `close` refuses with `ok: false` rather than throwing -
  an agent naming the wrong id is a runtime outcome, not a programming error.
- **An obligation a round does not name stays open.** A model that forgets has
  not approved, and failing closed is the only default that cannot be talked
  round.
- **Nothing is rewritten.** An obligation keeps the text it was raised with, so a
  reworded one is a new one.

Closures are applied before anything new is raised, so a round cannot raise and
close the same obligation in one call.

An id the ledger has nothing open for is refused by the **tool**, not silently
by the ledger afterwards. Measured with a small open-weight model: an auditor
with an empty ledger sent `resolved: [{ id: "1" }]`, inventing both the line and
the id format. The ledger refused it and the outcome was right, but nothing said
so anywhere a reader would look. Refusing in the tool tells the agent which ids
it may close and lets it call again inside the same turn, which is the only
moment it can still repair the mistake.

A boolean could only ever say that the work stopped. A ledger says which lines
are open and since which round, which is the difference between a pair making
progress and a pair that is stuck.

It buys nothing against a reviewer that closes an obligation it should not have.
That is still a judgement, about a single sentence the reviewer wrote itself
rather than about the whole of the work, and attributable to it.

The auditor in `deliver` signs the same way, and its fix lines are what go on the
ledger. Its prose is then not read at all: `deliver` has a concession for an
auditor that refuses in English without naming anyone, and that concession is
for prose-only auditors. Applied to one holding the tool it turned the word
`APPROVED`, written beside a call that said otherwise, into a fix a coder was
sent away to make. `DeliverResult.approved` then needs three things: the auditor signed off,
nothing it raised is still open, and the check passed. The check keeps the last
word it already had.

Obligations are the one thing besides the plan that survives a resume. A subtask
that was still being argued over runs again, because nobody signed off on the
tree it left; an obligation that was open is still open, and the resumed run
keeps its id rather than raising a duplicate of it. `BuildState.obligations` is
optional for a state written before the ledger existed, and an empty ledger is
the honest reading of that rather than a reason to refuse the file.

### The record is the one that joins the verdict to the ledger

The tool and the ledger were built in two places, `pair` and `deliver`, with the
same two callbacks wiring one to the other written out in each; and each round
of each workflow then made the same join by hand - take the last verdict, apply
its closures, raise what it raised, decide `said && settled`. `pair` had it in a
helper, `deliver` inline. The rule that makes the join safe, closures before
raises, was tested through `pair` and nowhere near `deliver`.

`src/review/review.ts` is the record: one per reviewer, both the tool and the
list. `reviewRecord(name, { byTool, inProse, restored })` builds the ledger and,
when the reviewer decides by tool, the tool wired to it. `record.tool` is what
the reviewer is offered, `record.open` what a round is asked about, `record.all`
what a result reports, and `record.close(review, round)` answers the one
question a round has: what was declared, whether the reviewer said yes, whether
that finishes anything, and what was raised. A review that did not run to
completion decided nothing, and the collector is drained regardless so a
verdict left behind by a failed turn cannot be read as the next round's.

`byTool` is the caller's to say, not the record's to infer: `pair` lets a
caller's own `approved` predicate stand in for the tool whatever the agent
declares, and that is `pair`'s rule to keep readable in `pair.ts`.

`lastVerdict` is gone. It was one line, its only callers were the two joins,
and the rule it carried - the last call wins, because an agent that calls again
has changed its mind - is the record's to state. `verdict.ts` and `ledger.ts`
stay as they are, each with its own rules and its own tests: the record joins
them, it does not absorb them.

### A working copy belongs to the work, not to the subagent

`deliver` pins `concurrency` to 2 because its workers write to the same tree.
A git worktree each turns that into a question about the tasks rather than about
the filesystem, and `pair` takes `worktree: true` to ask for one.

The copy is the **pair's**, not each agent's. A reviewer given its own would be
reading the code the worker did not touch, which is the one arrangement that
looks right and reviews nothing.

Two consequences that were found by writing it rather than by reasoning about
it. `git worktree remove` refuses a copy holding changes and knows nothing about
the patch a caller is holding, so `patched: true` is both our guard and the only
thing that lifts git's. And `pair` cannot return from inside its round loop any
more: the copy is released in the `finally`, and a result built before that
carries no patch.

A copy that cannot be made stops the pair. Carrying on would write into the tree
the caller asked to spare, which is the failure the option exists to prevent.
And a copy that cannot be **released** fails it too: the first version dropped
that error, so an approved pair whose patch never came back was indistinguishable
from one that wrote nothing, while the work sat in a temporary directory nothing
named. The path goes in the error.

`worktree` is an option of `pair`, not of `WorkflowOptions`. On the shared type
every workflow accepts it and one honours it, which is a silent no-op for the
rest - `fanOut({ worktree: true })` would typecheck and run in the caller's tree.

The work is **committed** on the copy's branch before the copy goes. A first run
left the branches pointing at the base commit, holding nothing, one pair of them
per run: the patch was the only copy of the work and `PairResult.worktree` named
something empty. A branch that turns out to hold nothing is cleared with
`git branch -d`, which refuses any that holds something.

### A shared directory is a channel, so several writers get copies by default

`deliver` used to share one working tree unless somebody asked otherwise, and
the reason given was the race: two workers writing over each other. A probe
measured something worse. Four subagents given **one** directory, told only to
write a file and list what they saw, each read the other three's files inside a
single turn without being asked to look. The same four in four directories
crossed nothing. A shared `cwd` is not a hazard the workers might hit, it is a
channel they use.

So the default flipped: with more than one subtask, every pair gets a copy.
`worktree: true` and `worktree: false` are still obeyed exactly as written; what
changed is what *nothing* means. A delivery of one subtask keeps writing where it
was told - it has nobody to leak to, and `/build` on your own repository is the
case that would be ruined by isolating it.

The decision needs the plan, so it is taken after planning rather than in the
options: the number of writers is the whole question, and it is not known before.

**Choosing it also means checking it is possible, before the work.** Copies come
home through `land`, and `land` refuses a tree that already has changes in it -
which is the normal state of a repository somebody is working in. Discovering
that after two subtasks have run is paying for them twice, so a delivery that
turned isolation on by itself asks `landable()` first and stops with both ways
out in the message. Asked for explicitly, nothing is second-guessed: the failure
stays where it always was.

The flag had to grow a third answer for any of this to survive the trip through a
command. `--worktree` absent used to arrive as `false`, which is an answer; it
now arrives as nothing at all, and `--worktree=false` is how a person says no.
An option that a caller may leave unsaid must not be coerced on its way down, or
the default is decided by the plumbing.

A copy bounds writes, not reads. `..`, `/tmp` and everything else the `read` tool
reaches are outside any worktree, and a subagent that goes looking still finds
them. What closes is the channel that opens by accident.

One thing had to be true elsewhere for any of this to work on a real
repository: **a run's own exports are invisible to git**. They land in `runs/`
inside the tree the delivery is about to land in, so while git counted them the
answer to "can the patches come back" was always no.

### Patches go in one at a time, and nothing is undone

Two patches that each apply cleanly on their own can still be wrong together:
one renames what the other calls, both add the same helper under two names, or
the second simply overlaps the first. Three ways of dealing with that were
weighed.

**Hand them back and merge nothing.** Honest, and it leaves `deliver` stopping
one step short of where it stops today. It also makes the common case, subtasks
that really were disjoint, cost a human a manual step every time.

**Apply them all, then check once.** Cheapest, and it answers the wrong
question: a red tree after three patches says only that one of them broke it.

**One at a time, with the check between them**, which is what `land` does. Which
patch broke the tree is then a fact rather than a bisection, and the cost is one
run of the suite per patch, paid only by callers who gave a `verify`.

A patch is checked before it is applied, so one that does not fit touches
nothing. `--3way` is deliberately not used: it writes conflict markers into the
files and calls that success, and a caller left to find markers in a tree it
believed clean is worse off than one told the patch was refused.

**Nothing is rolled back.** A failure stops the rest where it is and what landed
stays landed. Undoing would mean discarding work that was expensive to produce,
and every patch is also on a branch, so nothing is lost by leaving the tree
readable. The tree must be clean to start with, for the same reason: landing
onto somebody else's changes makes "which patch broke this" unanswerable, which
is the one question the whole arrangement exists to answer.

Landing adds no commit and moves no ref. What goes in stays in the working tree,
the way `deliver` already leaves its work for a human to read.

`deliver` takes `worktree` and does both halves: a copy per subtask, then a
landing per batch of them. That is why the two were built in this order -
`deliver`'s check had nowhere to run while the work sat in copies nothing put
back, so the policy had to exist before the delivery could use the mechanism.

`approved` gains a third condition there: the auditor signed off, nothing it
raised is open, the check passed, **and** every patch reached the tree. Work
nobody could land is not delivered, whatever was said about the reports.

A delivery lands more than once: the planned subtasks, then each round of audit
fixes. Only the first of those meets a tree it did not write, so the clean-tree
precondition is the **first** caller's and not every call's. Measured: with it
on every call, a real delivery whose audit asked for one fix had that fix
refused with "refusing to land onto a tree that already has changes in it" -
changes the delivery had put there itself one step earlier.

It still does not combine with `resume`. A resumed delivery finds a tree holding
what a previous process landed, which it has no record of, so it cannot tell
that work from somebody else's. That refusal is right rather than missing.

### How the work reaches the tree is one policy, asked once

`deliver` decided its copies in five places: whether to isolate, from the
number of writers; the pre-flight on the tree, only when that decision was its
own, with a refusal in two spellings; the `worktree` it handed each pair; a
`settle` that landed a batch or only ran the check; and a list of landings whose
first entry alone had to meet a clean tree, and whose every entry weighed on
`approved`. Five rules of one concept, between the plan and the audit.

`settle.ts` is the concept. `settling({ cwd, worktree, writers, verify })`
decides, pre-flights and refuses; what it returns says whether pairs are
isolated, settles a batch and answers with the tree's check, and keeps the
landings and whether every patch reached the tree. `deliver` asks once after
the plan, hands `isolate` to `pair`, settles after the subtasks and after each
round of fixes through the audit's `fix`, and reads `landings` and `landed` for
the result. It names neither `land` nor `landable` any more: `land.ts` stays the
mechanism any caller may use, and this is what a delivery does with it.

The `worktree` knob does not move. It is `pair`'s and `deliver`'s, for the
reason the decision above gives, and `pair`'s side - one copy for one piece of
work, released in the `finally`, the path named when it could not be - was
already the shape a single copy wants. What this settles is the batch.

**Two `git status` on the same tree, kept on purpose.** A review read the
pre-flight in `settling` and the clean-tree check `land` makes on the first
landing as one question asked twice, and proposed that `settle` own it once
and `land` take the answer. They are the same question at two moments. The
pre-flight answers before any work, so that no subtask is paid for whose patch
cannot come home; the landing-time check answers on the tree as it stands then,
minutes later. Nothing of combo's writes into that tree in between - the pairs
write in copies - but the person whose tree it is may, while `/build` runs,
and a patch landed onto their edits would make "which patch broke this"
unanswerable, which is the one question `land` exists to answer. The first
check is a warning the second can only be anticipated by; removing the second
would trade the guard for one `git status`. The comment now sits at the call,
so the next reader does not have to rediscover it.

`settling` keeps returning a `GitResult`. Its refusal is what git said about the
tree, with both ways out appended; a ninth two-armed outcome type for the same
fact would be one more shape to learn, not one less.


`timeoutMs` has no default in the library, deliberately: it cannot know how long
a task should take. A command can, and `/interview` has to. The interviewer
reads the repository between questions, pi's agent loop has no step cap, and the
person waiting for the next question cannot tell a slow turn from a stuck one.
Five minutes is what `NEXT.md` measures these models at; 120s fails roughly half
the turns, so a shorter one would cut work that was going to finish.

The interview writes its transcript too, into the same `runs/<timestamp>/` the
pipeline uses, and that folder is now made **before** it rather than after. A
failed interview used to leave nothing behind, which is the one moment the only
question worth asking is what was actually sent - a report of `[node9] prompt
blocked` from a guard sitting in front of the provider had no record to check it
against. The failure names the folder.

The interview is also watched like everything else. It had a fixed
`interviewing…` and no reporter, so its first turn - 35 seconds and seven file
reads, measured on this repository - looked exactly like a turn that had hung.
Display is an observer and unplugging it changes no result, which is why adding
it here costs nothing and why leaving it out cost the only thing it could: the
user's confidence that anything was happening.

The same place had `--model` checked before the interview and then not used by
it, so the interviewer ran on whatever `~/.pi/agent/settings.json` named. That is
the hole invariant 5 exists to close, one command away from where it was closed
everywhere else.

### The interview answers in the language it was asked in

A question the user reads less precisely is one they answer less precisely, and
the specification is the artefact they are handed to correct before anything is
built on it. Both come back in the language of the request.

It does not contradict the English-everywhere rule: that rule governs what is
written into the repository, and none of this is. The **specification** does
travel on to the planner, the coder, the reviewer and the auditor, whose own
prompts stay English. A model takes a request in any language without trouble,
and the person signing off on the spec reading it exactly is worth more than a
uniform pipeline.

Two things are exempted by name, and both would break silently otherwise.
`parseQuestion` reads the question by its JSON **keys**, so a translated
`options` is a question nobody can display. And the loop ends on `READY`: a model
told to write French writes `PRÊT`, which is an interview that never finishes and
burns every one of its questions first.

This was the first place output left English, and for a while the only one -
[every subagent answers that way now](#every-subagent-answers-in-the-language-it-was-given).
The per-turn reminder stays: it is the one prompt that names its own two
exemptions, and an interview that loses `READY` costs six questions before
anybody notices.

## A subagent may have subagents

An agent whose `tools:` names `subagent` is handed `delegateTool()`, and can
split its task across children of its own. `examples/14-delegation-tree.ts` is
the case it was built for: one explorer that cannot read a large repository in a
turn, three scouts that each read a part, one note back.

**This is the second exception to invariant 5**, and the only one besides
`situate()`. Granting it is not inheritance: the tool comes from combo rather
than from the user's machine, the roster is the one the caller passed, and an
agent that does not name the tool in its own definition cannot have it. What an
agent can do stays readable in its file, which is the part of that invariant
that was ever load-bearing. It is still an exception to the letter, which is why
`AGENTS.md` names it.

The tool is built outside `spawn` and handed over through
`SpawnOptions.customTools`, the seam the verdict tool already uses. `spawn` never
learns what a roster is, and the recursion stays in one file: a child that
declares the tool is handed one built at `depth + 1`.

**How wide, and how deep, are decided by different people.** The roster and the
bound are the caller's: what an agent may reach, and how far a tree may grow,
are facts about the run. `concurrency:` is the agent's own, read from its
frontmatter, because how many pieces a task is worth splitting into follows from
how the agent was told to think about it. An explorer asked for two to four
tasks wants three in flight, and that belongs beside the instruction that asked
for them rather than at every call site.

A child that delegates in turn is read the same way, from its own file.

**The depth guard ships with the feature.** Delegation that can go on forever is
a bill discovered afterwards. Two levels by default - the session, a child, a
grandchild - which is where a split stops paying, because a grandchild rarely
knows enough about the whole to split anything usefully.

At the bound the tool is still handed over and refuses when called, saying how
deep it is and how deep it may go. Withholding it would leave a model calling a
tool that does not exist, getting "unknown tool" back and trying again, which is
the runaway turn `timeoutMs` exists to survive rather than one to cause.

The bound travels in a closure. Nothing reads the environment for it: an ambient
variable is how the model hole in invariant 5 existed, and that mistake is not
worth making twice.

## Delegation reaches pi the way it reached a script

The `subagent` tool wires `delegateTool` for **any agent whose definition names
it**, and for nobody else. No flag turns it on: a call that enabled delegation
would be the caller granting a capability the agent's file does not admit to,
which is the whole of invariant 5 read backwards. `maxDepth` only tightens the
bound the library already has.

The children inherit the **call's** terms - model, deadline, export directory,
signal - and not its lifetime: a delegated child is disposable, whatever the
parent was asked to be. `orchestrate` gets it too, through the same
`customTools`, so a planner's worker that declares the tool can split its share.

The drawing follows `parentId` rather than the spawn order, everywhere at once:
the dots above the prompt, the collapsed tool row, the expanded view. A
`WidgetRow` carries a `depth` and the terminal applies the indent - the
collector lays out and never draws, the same split the rest of the display
already keeps. A run with no delegation renders exactly as it did, which is the
property the tests pin.

## A fan-out reads in the order it was launched

Three scouts launched together drew as `scout#2, scout#1, scout#3`, and stayed
that way for the whole run. The collector kept arrival order and the comment
above it claimed launch order, so the defect was one line of documentation away
from being invisible.

`spawn()` takes the id synchronously and emits the `spawn` event only after
`await createSession()`, because the event carries the model pi resolved. Rows
therefore land in the order sessions came *up*, which is a property of the
provider and not of the run.

The fix is a number on the event: `nextSubagentId` hands out the id and the
launch order together, since they are one fact - the moment the subagent was
asked for - and a second counter kept elsewhere would drift the day one of the
two calls moved. The collector sorts on it and keeps it to itself: where a row
is drawn is the display's business, and `SubagentSnapshot` stays about the
subagent.

Two alternatives were worse. Sorting by id breaks a chain, where
`planner#1, coder#1, reviewer#1` is chronological and alphabetical order is
nonsense. Emitting the event before the session exists means emitting it without
the model, and the model on the spawn event is what makes a run say on its face
what it ran on.

## What a delegated run costs is a tree

A delegation with no tree-shaped measurement is a cost discovered on the
invoice: two children and their six grandchildren read as eight peers, and the
agent that caused the bill reads as the cheapest row in it.

The link is **the parent's id, on the `spawn` event**. Not a name, which two
explorers running at once already share. Not a lookup into the core either -
invariant 4 stands, a reporter observes and never queries, the same reason
`openInHerdr` travels on the event.

**The id is minted by `spawn`**, so a tool that will spawn children cannot be
built before the subagent that holds it exists. Hence `SpawnOptions.customTools`
accepting a function of the id to come, next to the list it already took. The
alternatives were worse: generating the id outside `spawn` scatters the one
place a subagent is named, and a mutable box filled in after the fact is a
lifetime bug waiting for a second caller. The list form stays because most tools
- a verdict, a check - have no use for an id, and paying for delegation
everywhere would be the tax invariant 11 exists to refuse.

**The measurement stays a flat list carrying a link, rather than nesting.**
`usage.json` keeps `subagents` flat with a `parentId` on each row, ordered so a
child follows its parent; `summaryTable` indents. Nesting the document would
force every reader to walk a tree to sum it, for a total that is a sum over
every row either way. The tree is one pass away for whoever wants one -
`treeOrder` is that pass - and no reader written against the flat shape breaks.

Two properties are pinned by tests because losing either would be silent:
**nothing is ever dropped** - a subagent whose parent is not in the list reads
as a root, and even a pair pointing at each other is still reported - and **the
total is the whole tree**, failed children included.

## A subagent may name skills

An agent's `skills:` is an allowlist, read exactly like `tools:`. What it names
is resolved before pi is opened and handed to the resource loader; what it does
not name is absent, whatever the machine holds.

**This is the third exception to invariant 5**, and the widest one: a name
resolves against the repository's `.pi/skills/` and the user's
`~/.pi/agent/skills/`, so two machines can disagree about what a name means.
That was the choice, and it is a trade rather than an oversight. The reason to
take it: a skill is the unit people already have - they write them, share them,
and hold directories full of them - and a library that refused to look there
would be answered by pasting a skill's text into a prompt, which is the same
dependency with none of the versioning. The reason it is survivable: the *name*
is still written in the definition, so what an agent can do is still readable in
its file, and `agents/<name>/skills/` is searched first, so anything that must
be reproducible ships beside its definition and wins the name.

Three ways a declared skill could have been dropped in silence, and none of them
is:

- A name matching nothing **throws at spawn**, naming the three directories.
  Prose that quietly lacks a step is the expensive failure, not a stopped run.
- A skill needs `read`: pi omits the whole section from a system prompt whose
  toolset cannot open a file. Handing the tool over instead was rejected -
  widening an allowlist to satisfy another field is exactly the silent grant
  invariant 7 exists against.
- `disable-model-invocation` is refused rather than honoured. pi keeps such a
  skill out of the prompt entirely, and combo has no `/skill:` for the model to
  reach it with, so accepting one would offer a capability that cannot arrive.

Nothing is loaded eagerly. pi advertises a name, a description and a path; the
model opens `SKILL.md` itself with `read`. A skill costs a line of prompt until
it is used.

## Pipelines: a workflow written down

`src/pipeline/pipeline.ts` parses one, `src/pipeline/load.ts` finds it, and
`src/pipeline/run.ts` walks it. `/build` runs one.

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
- **`/agents` answers the same question `/pipelines` does**, for the roster, and
  it is grouped by source rather than sorted by name because the question behind
  it is nearly always a scope: the agent is *there*, and the call that could not
  find it was loading somewhere else. A source that contributed nothing still
  names the directory it read, since "where do I put mine" is the other half of
  the same question. Its first run against this repository found `explorer`
  shipped with no symlink into `.pi/agents/`, which a test now pins.
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
  `liveRun` in `extension/ui/run.ts`: two call sites, two timers and two ways of
  clearing a widget is exactly how the one nobody is watching that day drifts.

## A chain walked by hand

`/run explore …` put its answer in the conversation, and the session picked it
up and started orchestrating: every later command was chosen against a
conclusion the main window had already drawn. That is the documented behaviour
of `/run` working exactly as decided - an exploration is read and then asked
about - and it is the wrong default for the other use, where the main window is
a console and the chain is `explorer → planner → coder → reviewer` advanced one
step at a time. So a knob, not a reversal: `/step`, `/chain`, `/quote`.

- **The output goes to a relay, not to the conversation.** `appendEntry` draws
  the step in the transcript and keeps it out of the model's context, and the
  text waits in module state for the next command. `/quote` is the single door
  into the conversation, taken on purpose, with the same framing `/run` uses -
  pi turns a custom message into a **user** message, and an unattributed report
  in that slot reads as an instruction.
- **A `Result` crosses, never a context.** Which is the lifetime rule already:
  persistent subagents do not share history, you pass `Result`s. Each `/step`
  opens a subagent and closes it, so there is no live session to own between two
  commands and nothing to leak if pi is quit in the middle. Carrying a
  conversation would also have made `--model` per step meaningless.
- **A step is handed `stepInput`, the same three sections a pipeline's steps
  get.** A chain walked by hand and the same chain written down then send the
  model byte-for-byte the same thing, which is the only way the two can be
  compared. A first step carries nothing and is passed through verbatim, as
  `/run` passes its request: a lone instruction under a `## Request` heading is
  noise.
- **A step may be a pipeline or an agent**, resolved in that order, because
  `explore` - a fan-out and a synthesis - is a perfectly good stage of a chain
  and so is a lone `planner`. A name held by both runs the pipeline and says so,
  and `--agent` is there so that the collision is not a dead end. A name held by
  neither is one message, not two listings.
- **A failed step leaves the chain untouched.** It produced no material, and
  recording it would hand the next agent an error message as its input. The
  export stays on disk and the same command can be retried on another model,
  which is the whole reason a step is typed rather than walked.
- **One folder for the chain, one subfolder per step.** A chain walked by hand
  is still a run, and leaves the same trace as one walked by `/run`. What
  `/chain` totals is the sum of the steps' own wall time, not the age of the
  chain: most of a hand-walked chain is spent waiting for a human, and counting
  that as work would be an estimate.
- **`/quote` and not `/share`**, which is what it was called until a real pi
  said so at startup: `share` is one of pi's own twenty-three built-in slash
  commands, and an extension command of that name is dropped from its own
  autocomplete. No test here could have caught it - the fake `pi` a test hands
  the extension has no built-ins to collide with. `quote` is also the better
  word: what lands in the conversation is a quotation, attributed and read as
  one.

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
- **A refused turn does not.** Asking a subagent that has already been stopped
  returns without reaching the session, so `turns` stays where it was: there was
  no request and no answer, and a turn nobody made is the one kind of number
  this section exists to keep out. A failure that *ran* still counts, which is
  the line between the two.
- **Never** estimate tokens by counting characters. If the provider does not
  report them, the field is `0` and we say so.

### Usage does its own arithmetic

`sumUsage` existed, and four places did not use it. The subagent's cumulative
usage added a turn field by field; `usage.json` flattened its total into a
record by naming the fields, leaving two out; the experiment report summed
those records key by key and turned them back into a `Usage` by naming the
fields again; and the hand-walked chain summed its steps in a `reduce` of its
own. A tenth field on `Usage` would have needed six edits and would have
vanished from the experiment table without a test saying so, and the clamp at
zero lived in `deltaUsage` alone.

The arithmetic is `usage.ts`'s: `deltaUsage` for a turn, `accumulate` for a
subagent's life - the one rule `sumUsage` does not have, that a context is a
level replaced by the latest reading rather than a counter summed - and
`sumUsage` for several subagents. Nothing outside the file names the field
list. `usage.json`'s total is a `Usage` with the subagent count beside it, and
its `wallMs` is the run's; the experiment summary is a `sumUsage` over the
cells with their wall times added, because they ran one after another, and its
own `wallMs` field went into the total rather than standing beside it as a
second copy. `asUsage` is gone with the record it read back.

## Session export

Two formats, two uses, both provided by pi (`AgentSession`):

```typescript
await session.exportToHtml(outputPath?);  // → path of the HTML file, readable/shareable
session.exportToJsonl(outputPath?);       // → JSONL of the current branch, replayable
```

Implemented in `src/measure/export.ts`, wired into `spawn` and every workflow
through `exportDir`.

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
- **`runs/` gets a `.gitignore` of `*`, written once.** The exports land inside
  the repository the run is working on, and git has no business with them.
  Nobody had hit that here because *this* repository ignores `runs/` in its own
  `.gitignore`: the defect only shows in somebody else's. Two ways it shows, both
  measured in a real run. A delivery given `worktree: true` cannot put its
  subtasks' patches back, because `land` refuses a tree that is not clean and
  `runs/` alone makes it unclean. And `/build` commits with `git add -A`, which
  sweeps a run's transcripts into the user's history.

  Relaxing the landing was the other candidate and a test refused it: a delivery
  lands twice, and the second time it has to recognise the work the first one
  left, which is precisely untracked files. So the export gets out of git's way
  instead of git being told to look away. A `.gitignore` already in `runs/` is
  left alone - the directory is the user's the moment they have said anything
  about it.

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
Verified against herdr 0.9.0, protocol 22, by `node scripts/check-herdr.ts` and
by a run with panes open.

**The key idea, because it is not the obvious one.** A herdr pane cannot *host*
an in-process subagent: there is no process and no TTY to attach. So the pane
does not host the subagent - it **displays a stream we write**. We append to a
file and open a pane running `tail -n +1 -f` on it, which takes three calls
because herdr has no single call that does all three:

```typescript
pane.split      { direction: "right", target_pane_id: ours, focus: false }   // → result.pane.pane_id
pane.rename     { pane_id, label: "reviewer#2" }
pane.send_input { pane_id, text: "exec tail -n +1 -f '<log>'", keys: ["enter"] }
```

`target_pane_id` is ours, from `HERDR_PANE_ID`: with none, herdr splits whatever
pane is focused, which can belong to another client.

`exec`, so the pane *is* the stream - closing it closes what it follows - and
the clear that puts the name at the top is written into the log file rather than
run as a command, because the shell is still starting up and writes over
anything printed before it has finished. Measured, as a zsh history warning
sitting on top of a member's first turn.

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
- **`pane.split` answers with the `pane_id`** (`result.pane.pane_id`), which is
  the only way to later name, run in, report on, release and close that pane.
- **`agent.start` is not that call**, whatever its name suggests: it starts a
  *recognised* agent in a pane that already exists. `pane.split` is what makes
  panes. See the reversal below.
- **Release before close.** Closing first leaves herdr holding an agent on a
  pane that no longer exists.
- **Every promise chain ends in a `catch`.** A try/catch around the listener is
  not enough: an unhandled rejection escapes it entirely and takes the process
  down. Found by a test, not by reading.
- `seq` is a monotonic ordering field; seed it from the clock like the pi
  integration does, so two processes reporting on one pane do not collide.
- Useful CLI equivalents when debugging: `herdr pane list`, `herdr agent list`,
  `herdr pane read <pane_id> --source visible`. The read sources are
  `visible | recent | recent_unwrapped | detection`, with an underscore - the
  CLI's own `--source recent-unwrapped` is spelt the other way and the socket
  refuses it.

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

**A board gets a pane, and it is not an agent.** A pane per member shows each
one working and none of them talking: what a member said is in its own pane, and
who it was addressing is only legible where all of them are. So the first thing
anybody says opens one more pane, named `board`, carrying the exchange in order,
and each member's pane keeps its own half of it without repeating its own name.
Nobody works in that pane, so no agent state is ever reported on it and nothing
is released when it closes - a pane that never had an agent has none to give
back, which is now what `finish` checks rather than assumes. It opens only when
the run is watched at all, and closes with the last member.

**Reversed: `agent.start` was never the call that opens a pane.** Under herdr
0.7.3 it took an `argv` and a `split` and did open one. By 0.9.0 it takes a
`kind` and a `pane_id` and starts a recognised agent in an existing pane, so
every request combo sent was answered `invalid_request`. Nothing said so: a
reporter must never throw, so the refusal was swallowed, `paneIdOf` gave
`undefined`, and every call after it was skipped by design. `/herdr on` warned
only about herdr being absent, which it was not. The suite stayed green over a
feature that opened nothing at all, because every test of it asserted on combo's
own idea of the request.

The guard for it is not another test. `node scripts/check-herdr.ts` runs the
reporter through a subagent's whole life against a recording transport, then
holds every request it made to `herdr api schema --json`. Because it validates
what the code sends rather than a copy of it, it cannot drift from the code the
way example payloads would; run against the shape that shipped, it names both
missing fields. `scripts/drive-pi.py` plays the same part for pi: a check a fake
cannot perform, run by hand.

**`/herdr on` asks herdr, and says what it heard.** Being inside herdr was the
only question it used to ask, and it is the wrong one on its own: a herdr that
answers `invalid_request` to everything is indistinguishable from a working one
until a run opens no panes. Nothing in the reporter may say so, because a
reporter that warns is a participant, so the command says it instead.

The probe is harmless because of the pane it names. `pane.split` sent with a
`target_pane_id` no herdr can have separates the two answers: `invalid_request`
when the request itself is wrong, `pane_not_found` when it was understood and
only that pane was missing. Neither opens anything, and if some later herdr
splits anyway, the probe closes what it got. It asks about `pane.split` alone,
because nothing else runs without the pane id it returns;
`scripts/check-herdr.ts` covers the other five, against the schema rather than a
live server. The params come from one function (`splitParams`), so a probe
cannot go on answering yes about a request the reporter no longer makes.

The preference is set whatever the answer. What a user wants for the session is
not herdr's to decide, and a `/herdr on` that silently declined to be on would
be a second way to be surprised by an empty screen.

Two tests asserted that the suite runs outside herdr. It does not, for anyone
developing this in the window it is written for: both passed for the wrong
reason there, and one of them opened a pane in the terminal running `npm test`.
`test/fixtures/no-herdr.ts` takes the markers out of the environment for the
length of a body, so the suite answers the same either way.

The wording of those lines lives in `src/reporters/traffic.ts` and nowhere else.
The console and a herdr pane are read side by side when a run is compared
against another, and a difference in how they say it would read as a difference
in what happened.

**Reversed: a subagent's pane hosts a client, not a file.** The `tail -f`
above was the right answer to a pane that cannot host a subagent, and the
wrong shape for two things asked of it since: to read like pi, and to take a
word for the subagent. A text file can do neither. The split now runs
`pane/main.ts`, a client of the mirror, so what it draws is pi's chat and what
is typed into it reaches the turn in flight. The three herdr calls are the
same three, with a different command typed into the shell; the file, the
one-line tool summary and the usage line the reporter used to write are gone
from it, because the pane draws them from the session itself. Text, tool and
usage events still flow on the bus for every other reporter, and the herdr
reporter reads only `spawn`, `status` and `close` from it: what herdr must be
told, and nothing the pane already knows.

The command names the binary this process runs on (`process.execPath`) and
the client where the package keeps it, both quoted, because the split's shell
may find another `node` or none, and a pane opening on a usage error says
nothing about why. When this process is not node at all, the shell's `node` is
the one candidate left.

The board keeps its file. Nobody works in it and nothing is typed to it, and
its lines are the console's, which is the property worth keeping there. A
member's own pane no longer repeats its half of the traffic: the tool calls
it made are drawn as tool calls, which is how pi would show them. The console
keeps the `⌨` line for a steer, and `traffic.ts` does not carry it, because
the pane draws a steer as the user message it becomes and two displays of one
run must not say it twice.

**A reporter that nobody subscribes reports nothing.** `onEvent` takes a single
listener, so watching in the TUI *and* in herdr means composing them - use
`combineReporters(collector.reporter, createHerdrReporter())`, which drops the
`undefined` that `createHerdrReporter` returns outside herdr. The extension once
passed `openInHerdr` all the way to the `spawn` event with nobody listening, and
nothing failed: no split, no error, no clue.

### The mirror: a live session on a socket, and what a typed word may do

A pane cannot host an in-process subagent, and the `tail -f` above shows one
without letting anybody speak to it. What a pane *can* host is a client: the
mirror (`src/mirror.ts`, wire in `mirror-wire.ts`) registers every live
subagent by id on one unix socket per process, replays `session.messages` to
whoever attaches, then forwards pi's own session events as they come. pi's own
chat components are written against exactly those events, so a client built
from them draws the session the way pi would.

The mirror is **not a reporter**. A reporter reads the stream and never reaches
the session; this one takes `steer` and `abort` from the socket and applies
them. It is a port of the core, beside `ask.ts` and `verify.ts`, and it is
reached only by the act that opens a pane. Registration is a map entry, so
every subagent registers and no socket exists until something asks for its
path: the suite spawns hundreds of fakes and listens on nothing.

**Nothing typed while idle is queued.** Probed, on two pi generations with
the same answer: a `steer` queued on an idle session is delivered with the
next `prompt()` and answered *in place of it* (`user SECOND → user STEERED →
assistant STEERED`); a `followUp` queued while idle is answered *inside* the
next `prompt()`, after the task, so `lastAssistantText` reads the person's
exchange back as the workflow's result. Either silently changes a turn the
workflow believes it composed. So a steer is accepted only while
`session.isStreaming`, refused otherwise with a reason the pane can print, and
`followUp` is not on `SessionPort` at all. Mid-turn a steer lands after the
tool call in flight and the transcript `ask` returns carries it, which is the
feature.

**A steer is an event.** `{ type: "steer", id, text }` goes on the bus when
one went through, so `events.jsonl`, the console and the pane say a person
spoke and where. A run somebody steered is not the run they would have got by
watching, and the record is what tells the two apart afterwards. The line is
`traffic.ts`'s (`⌨ scout#1 ← …`), for the reason every line there is: two
displays of one run must say the same thing.

**The socket path does not ride on the `spawn` event.** The plan had it
there, beside `openInHerdr`; it is a process-wide fact and not a subagent's,
so `mirrorSocket()` answers it once and the same path serves everyone alive.
A reporter asking a module for a path is not a reporter querying the run.

`attached` names the pi package this process resolved
(`import.meta.resolve`), because the events are that pi's and the components
reading them have to be too - the version trap above, seen from the other side.

### The pane is pi's chat, fed by the mirror

`pane/` is the client a herdr split runs: a `TUI` over a `ProcessTerminal`,
a chat of `UserMessageComponent`, `AssistantMessageComponent` and
`ToolExecutionComponent`, an `Editor`, two lines of footer. The chat runs the
switch pi's own interactive mode runs over the same events, which is why it
looks like pi: there was no drawing to invent, only a session to be fed.

It sits at the top level like `extension/`, because it is pi UI code and
imports `@earendil-works/pi-tui`, which `src/` never does: the TUI collector
stays free of it so a snapshot can be tested without a terminal, and so does
this, on `render(width)` of the components themselves.

**It imports pi statically**, from the same tree as `src/`. The plan had it
import the package from the URL `attached` carries, so the components would be
the version that produced the events; but `pane/` and `src/` resolve the bare
specifier the same way from the same checkout, so the URL adds nothing here and
a dynamic import would cost the types. The URL stays on the wire as a fact a
client may compare against its own resolution, and nothing reads it yet.

**pi's editor theme is not exported.** `getEditorTheme()` lives in pi's theme
module and `index.ts` does not re-export it, and `theme` itself is not exported
either, so the pane's editor border is plain dim rather than the theme's
`borderMuted`. The select list inside it is the theme's, through
`getSelectListTheme()`, which is exported.

Verified in a pty against a real subagent: the task, the thinking, each `read`
in its box, the answer; a line typed one second into the turn shown as a user
box, the model's answer to it below, and `Result.output` reading `STEERED` on
the library's side; a line typed after the close answered `done - nobody is
listening`. The frame was drawn with `scripts/frame.py`, which is the check no
fake can do.

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

### One picture of the run, and readers that do not fold

The TUI collector held the fold of the event stream - who spawned, under whom,
doing what, at what cost - and it was not the only one. The console kept a
`depths` map of its own to indent a delegated subagent, the extension rebuilt
counts and a hand-summed total from the subagents pi handed back in a tool
result, and `setTask` sat on the collector's interface for a caller that no
longer existed, its TSDoc saying the core did not emit the task when `status`
had carried it for some time. A fix to the fold - the launch order of a
fan-out - reached the widget and nothing else.

The fold is one module now, `picture.ts`, named for what it is rather than for
the first thing that read it: `createRunPicture` folds, `RunSnapshot` is what
comes out, and `snapshotFrom` derives the counts and the total from a list of
subagents so the extension gets the same picture back from a serialised
result. Depth is a fact of the fold, decided when a subagent spawns from the
parent the picture had seen, and stored on the snapshot; `treeOrder` only puts
children after their parents. The console reads the depth from a picture of its
own instead of keeping one, `setTask` is gone, and `of(id)` takes its place on
the interface - a read where there was a write-in side door. Formatting stays
in `tui.ts`, with nothing to hold.

What did not move, and why: the herdr reporter keeps a map of the panes it
opened, which is effect state rather than a second copy of the run; the mirror
relays a session's events to a socket and holds nothing; and the pane client
lives in another process, fed by the wire, with three variables. None of them
re-derives what the picture knows.

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

### A measured run is the library's

The extension's live view and an experiment's cell assembled the same thing by
hand: a picture, a composition of listeners on it, a clock, and at the end
`usageReport(snapshot, wallMs)` written with `writeUsageReport`. The view added
the parent session's copy and swallowed a failed write; the cell added a
recorder and let a failed write throw. Two adapters at one seam with no name,
each free to drift from the other, and the guide's own example of an export
was a third copy.

`measuredRun({ dir?, record?, listeners?, mainSessionFile? })` in
`src/measure/measured.ts` is the seam: `onEvent` to subscribe, the `picture`,
`elapsedMs()`, and `finish()`, which writes `usage.json` with the time measured
and hands the report back, never throwing, because an export is an observer of
the run. The view is a measured run with a terminal on top and takes its `dir`
up front rather than at `stop()`, since `watched` knows it from the start. The
cell is a measured run with `record: true`, which is where `events.jsonl`
comes from now. A script that wants `usage.json` is one with nothing added,
and that is what the export guide shows.

`run-ui.ts` was four concepts at 224 lines: the view, the report, the herdr
session switch and the widget's paint. The report is the library's now, the
switch is `herdr-switch.ts` because the command sets it and the view reads it
and neither should reach into the other for a boolean, and the counter that
gives escape to a question card is `asking.ts` for the same reason: the card
sets it, the stop key reads it, and `ask-ui.ts` importing from `stop.ts` for
it made the card depend on the stop registry.

The assembly is asserted once, in `test/measured.test.ts`. The tool's two
export tests that proved the parent session's copy and its absence through the
tool are gone; the tool's tests still say where it exports and that it exports
nothing unasked, and the experiment's still say each cell gets its own
directory and its own stream.

### How a subagent stands is read once

The glyph that says how a subagent stands was decided in five places. The
widget rows folded `ok` and `status` into `● / ✓ / ✗`; a helper beside them
folded the same two into `⏳ / ✓ / ✗` for a collapsed text line; the tool's
card and its expanded view each wrote `ok === false ? ✗ : ✓`; the widget's
painter mapped a status to a colour; and the console wrote `✓` on every
`close`, whatever the result said. That last one is the bug the close event's
own comment records having fixed once, for every reporter that read the event
- it survived in the console because the console had a copy of the rule. The
text line, meanwhile, had no caller in production and a thorough test, which
is this repository's own trap in miniature.

`standingOf(snapshot)` is the one fold: the status, with a failure outranking
it. `statusIcon(standing)` and `statusColour(standing)` are the two tables read
off it, and every reader - the widget rows, the card, the summary table, the
painter, the console - draws what they give it. `●` while it lives, because
that is what the widget drew and what the guide shows; the `⏳` the display
specification above kept for a collapsed row went with the row nobody drew.
The console keeps `⏳` on its spawn line, which says something else: born, not
yet working.

### One lookup for a pipeline

The rule that a broken file is refused rather than silently replaced was
implemented three times, with three message shapes: in `findPipeline`, which
the extension never reached for a broken file because two of its callers
checked first; in `choosePipeline`, with a `command:` prefix its unknown-name
sibling never had; and in `resolveTarget`, which searched the catalogue itself
rather than call `findPipeline`, because it needed "absent" to fall through
to an agent instead of throwing. The catalogue was loaded with the same three
flags at three sites, where the roster had `loadRoster` and the paragraph
saying why.

`lookupPipeline(catalogue, name)` answers a pipeline or `undefined`, and throws
on a broken file of that name: absent is a thing a caller may act on, a file
that is right there and does not parse is not, and a caller that falls back on
`undefined` must never fall back past one. `findPipeline` is the lookup plus
"unknown name is an error, with what there is instead". `loadCatalogue` is
`loadRoster`'s sibling. `choosePipeline` is one line; `resolveTarget` calls the
lookup and keeps its own question, which was only ever "pipeline or agent";
`listPipelines` loads through the same door. One message, the library's, for
every command: the `run:` and `step:` prefixes went, as the unknown-name
message had never carried one.

## Stopping a run, and one subagent of it

A run already obeys a `signal`, and that is all it took to call the whole thing
off - as long as somebody held one. Two things were missing, and they are
different: **a signal cannot single a branch out**, because every subagent under
a workflow shares it and a combinator hands out no handles; and **a command had
no signal at all**, because pi's `ctx.signal` is the *agent run's*, which is
`undefined` while no turn is in flight. So `esc` during a `subagent` tool call
already stopped everything, and `esc` during `/run` stopped nothing at all.

`stopSwitch` (`src/stop.ts`) is the pair that fixes both: a signal to give the
workflow, and a `spawn` to give it too. The handles are registered on the way
out of that `spawn`, which is the only place they all pass - delegated children
included. `liveRun` builds one per run and hands the two to the call sites, so
the tool, `/run`, `/build` and `/step` are stoppable by the same act.

**Stopping is a `Subagent` method, not a second signal.** `stop()` aborts the
turn in flight and refuses every later one with `"stopped"`. One-way, because
that is what a person pressing a key means, and distinct from `close()`: the
session is still there to be exported, and whoever opened it still closes it.
The label matters more than it looks - a deadline, a cancelled run and a person
call for different reactions, and before this they all read `aborted`.

Three ways in, because no single one reaches every case:

- **`esc` stops everything, and is listened to rather than consumed.** pi binds
  it to `app.interrupt`; swallowing it would stop the subagents and leave the
  turn running, which hands the model a wall of `stopped` results and every
  freedom to delegate again. Not consuming it means one key with one meaning:
  inside a turn the turn goes too, and during a command pi's own handler finds
  nothing to abort and ours does the work.
- **`ctrl+↑↓` select and `ctrl+del` stops the selection.** The list is already
  on screen, so it is the list a key moves through; the three are bound to
  nothing in pi and are read only while a run is live, through
  `ctx.ui.onTerminalInput`. Registering `escape` as an extension shortcut was
  the other option and is a trap: pi checks extension shortcuts *before* its own
  keybindings and swallows the key whatever the handler does, so it would break
  interrupt, autocomplete cancellation and clearing the editor for the whole
  session.
- **`/stop [<id>|all]`** names one, which no key can. It is not enough on its
  own: pi executes an extension command immediately during a *turn*, but
  processes no submission at all while a slash command of its own is awaiting -
  measured, typing `/stop all` during `/run` ran nothing until the run was over.
  That is the whole reason `ctrl+del` exists.

**Stopping one branch is not stopping the run.** The branch comes back as a
failed `Result` and the workflow decides: a `fanOut` branch dies alone, a
pipeline step that fails ends the pipeline. Saying more than that in the
message would be a promise the extension is not in a position to keep.

**A question card owns `esc` while it is up.** The card had said "esc build
with what you have" since before a run could be stopped from the keyboard, and
the two meanings collided the first time somebody pressed it: measured on
`/build`, `esc` on the first card ended with `interview failed: stopped`. The
card resolved to a submit, the listener stopped every subagent of the run, and
the interviewer that had to write the brief was one of them. So `whileAsking`
in `extension/commands/stop.ts` holds the stop for the length of a question,
free-text box included, and `escape` falls through to pi as before. Held rather
than dropped, because the run's subagents are idle while a question waits: there
is nothing running that the key would have been pressed to call off. The other
way round - making the card's `esc` a cancel, so that both meanings agree - was
rejected, because it throws the answers away, and the reflex to escape out of a
dialog is exactly the moment those answers are worth keeping.

## One floor under the commands

Five commands launch work - `/build`, `/run`, `/step`, `/swarm`, `/interview` -
and each had written the same shape by hand: choose between the double and the
real thing at every use (`deps.runPipeline ?? runPipeline`, thirty-two times in
ten files), wrap the pre-spawn checks in the same `try`/`catch` that turns a
thrown explanation into a refusal (six copies), then `liveRun`, a footer status,
and a `try`/`finally` that stops the view and writes `usage.json` (five copies,
one of them clearing a status the stop had already cleared). `command.ts` was
called the floor they stood on and held the parser, `refuse` and the roster; the
order things happen in was still every command's own, and so was every way of
getting it slightly wrong.

The floor is three pieces now, each deep and composable, and deliberately not
one template function: the five commands have different shapes - three stops
for `/build`, an editor after the work for `/interview` - and a function taking
parse, target, work and report as parameters would be a configuration engine
with five callers. `resolved(deps)` applies the defaults once and hands back
doubles that are all present, treating a key holding `undefined` as unsaid for
the same reason `override()` does in `pipeline-run.ts`. `checked(ctx, fn)` runs
what must pass before a spawn and gives `undefined` back on a thrown
explanation, the shape every refusal already had. `watched(ctx, deps, { status,
dir, work })` puts the dots up, says what is running, hands the work its live
run, and takes everything down in a `finally` with the time this command
measured - one clock, which is also why a run's `usage.json` now carries the
command's wall time rather than the workflow's own.

Two moves came with it. `command.ts` was mixing four concepts at 253 lines, so
what a command reaches for is `deps.ts` and what was typed is `flags.ts`;
`BuildDeps` is `CommandDeps`, since it never was about one command. And
`pipelineVerifier` left `run-ui.ts`: three callers, none of which paints.

`checkModel` stays in each command's `checked` block rather than in `watched`:
`/build` has to refuse a mistyped model before the interview, and the interview
runs before anything is watched. What a command checks is its own; that it
checks before it spawns is the floor's.

The contract of the floor is asserted once, in `test/command.test.ts` - a
thrown work still throws after the clean-up, the footer and the widget are
cleared whatever happened, `usage.json` lands in the folder given - and the two
commands that each proved the widget goes when the run ends lost those tests.
Their own tests say what each command decides.

### The tool and the committer stand on it too

The floor was built for five commands and two launch sites stayed beside it.
The `subagent` tool opened its own `liveRun`, kept its own clock and wrote its
own `finally`, because it varies four things about the view - a second
reporter, `herdrAll`, the parent session's file, a progress line streamed on
every change - and `watched` let none of them through. And `/build`'s committer
ran through `deps.run` with `ctx.signal`, which the section above says is
`undefined` during a command: the one subagent of a build that neither `esc`
nor `/stop` could reach, with no dots to say it was working. Its footer status
was set and cleared by hand around it.

`Watched` takes `live`, the slice of `LiveRunOptions` a caller may vary, and
`status` became optional because the tool has no footer to write to; who stands
on the floor is a `Watcher`, a `ui` and a `signal`, which pi's command context
and the tool's deps both are. The live run keeps the clock - `elapsedMs()`, and
`stop(dir)` no longer takes a wall time it was handed - so the tool reads the
run's time off the view it ran under rather than keeping a second one. The
committer runs under `watched` with the run's `signal`, `spawn` and `onEvent`,
which is what puts it within reach of `/stop` and on the widget.

The tool's arguments were declared twice: a typebox `Schema` in `index.ts` for
pi, and a hand-kept `Params` in `execute.ts` for the code, each with its own
description of the same twenty-one fields. `Schema` lives in `execute.ts` and
`Params` is `Static<typeof Schema>`. Three of its fields are `enum`s now -
`mode`, `lifetime`, `scope` - so what the code accepts is what the model is
told: `asLifetime` silently took `"session"`, which the description never
named, and `asScope` took anything and fell back in silence; pi refuses what
the schema does not name, and the two validators are gone. What the model
sends is `extension/params.ts`, what the tool does stays `execute.ts`, and the
`switch` over the mode is `perform()`, apart from the wiring: the one file was
mixing three things at 345 lines.

The tool's widget test went the way the commands' did: the floor's contract is
asserted once, and the tool's tests say what the tool decides. The committer
has the test it was owed - the run's signal, not pi's.

### The relay owns the entry a step leaves

`/step` and `/swarm` both end a stage the same way: a numbered subfolder of the
chain for the transcripts, the step recorded in the relay, an entry appended to
the transcript. Each had written the folder name and the entry by hand, and
`/swarm` imported `STEP_ENTRY` and its type from `/step`'s file to do it - one
command depending on another to know what a step of the chain looks like in the
session. The two folders were also named differently: `/step` after the id,
`/swarm` after the agent, so a second swarm of the same member got a folder that
did not say which step it was.

Both now belong to `relay.ts`, which already owned the chain: `stepDir(relay,
id)` names the folder, `STEP_ENTRY` and `entryOf(step)` say what the transcript
gets, and `recordStep` takes the id the step ran under rather than minting one
afterwards, so the folder and the entry cannot disagree. The doors a command has
into the session - `SendMessage`, `AppendEntry`, and the `PipelineDeps` and
`StepDeps` that carry them - are in `deps.ts` with everything else a command
reaches for. What one command file still imports from another is the design
and not a leftover: `/build` opens with `/interview`'s function, and `/quote`
sends the message `/run` sends.

### The relay owns the life of a step

Owning the vocabulary left the sequence to the commands, and `/step` and
`/swarm` still spelled it out alike, eight moves each: continue or start the
chain, mint the id, name the folder, run under the dots, refuse on failure,
record, append the entry, notify. The entry went through
`injected.appendEntry?.(…)` - the door read off the raw dependencies, where
`resolved()` never looked, so a caller that forgot it got a step recorded in
the relay and never drawn, in silence, the very failure `resolved()` guards
against for every other dependency. `stepAnswer` and `pipelineAnswer` were one
framing in two files, each justified by the same paragraph about pi's
user-role slot.

`beginStep(name, runDir)` opens or continues the chain and names the id and
the folder before anything runs; `finishStep(begun, outcome, appendEntry)`
records under that id and appends the entry in the same call, so "recorded but
never drawn" cannot be written. What the commands keep is what each decides:
the flags, the target, the refusal's wording, the notification. The doors are
**required** on `PipelineDeps` and `StepDeps` rather than resolved to a
default: a door that quietly did nothing would be the failure the type exists
to prevent, so pi's is bound once in `sessionDoors` and a test hands a
recorder. `framed(what, asked, output)` is the one framing, in the relay, and
the pipeline's answer is a one-line caller of it.

The mechanism is asserted once, in `test/relay.test.ts`: a begun step opens or
continues the chain, a finished one is recorded under the id it began with and
its entry goes through the door. The two commands' tests keep saying what each
sends and what each draws, because that is the property they exist for.

## pi comes in through one door, and nothing casts it on the way

Every command handler took pi's `ExtensionCommandContext` and handed it on `as
unknown as CommandCtx`, eleven times, and `/stop` did the same into a slice of
its own. Written when pi's context and ours did not line up, the casts had
outlived that: an assignment compiles without them today. What they still did
was keep TypeScript from checking that pi's context has what a command reads,
which is the one check a fake cannot make - and the five slices of pi's UI the
extension read were declared in five files, `notify` three times over,
consistent with one another by luck rather than by construction.

`extension/pi.ts` is where pi comes in, and the only file under `extension/`
that names pi's context types. `Ui` is the slice of `ctx.ui` the extension
reads, declared once; `CommandCtx` is what a command is handed; `RunUi`,
`KeyUi`, `AskUi` and `StopCtx` are picked from `Ui`, narrow so a test's double
stays small, and never redeclared. `PiApi` is the slice of pi's API the
extension registers through, and the test's fake is typed as it rather than
cast `as never`, so a method pi renames fails at compile time. The two wirings
only the door knows - what the tool body is handed, `mainSessionFile` read off
pi's session manager included, and how a command reaches the session - are two
functions, `toolDeps` and `sessionDoors`, and they are tested.

A handler is written against `CommandCtx`. pi hands it the whole context, and
TypeScript checks at every `registerCommand` and at the tool's `execute` that
the whole has what the slice reads. That is the door, and it needs no adapter
function: an identity typed on both sides would be a pass-through, and the
check it would carry already happens at the assignment. The one cast left is in
the test that drives a registered handler with the fake, standing in for the
members pi has and the extension never reads.

### The audit cycle is the audit's

`auditOnce` took ten fields and did three things: a pool, a prompt, a turn.
Everything that made a round of audit a cycle - asking, closing the round in
the record, deriving the fixes and attaching the standing check to each, running
them, settling the tree, deciding whether another round was worth paying for -
was fifty lines of `deliver.ts`, and twenty of `deliver`'s tests were about
those lines and nothing else in a delivery. The two pure helpers the cycle used,
`fixesFrom` and `withCheck`, were tested; the caller that had to call them in the
right order with the right check was not, on its own.

`audit(options)` in `audit.ts` is the cycle. It builds the review record with
what a previous run raised, spawns a fresh auditor per round whatever the caller
runs with, reads the verdict, derives and dresses the fixes, and applies the two
rules that end a cycle early: a yes with nothing owed and no failing check
standing, or a round that asked for nothing and closed nothing. What it does not
know is how a fix reaches the tree. It is handed `fix(fixes)`, which runs them
and says what the check is afterwards, and `deliver` hands it the one that runs
a pair and settles the copies - which keeps everything about working copies in
`deliver`, where the next decision moves it. `deliver` reads as plan, work,
audit, settle.

The move surfaced a double count. A fix's result was appended to `tasks` so the
next auditor would read it, and the delivery's usage summed `tasks` and then
every round's `results` again. A delivery with a fix reported the fix's tokens
twice, and the one usage test had no fix in it. The total is planning, the tasks
as audited last - fixes included, once - and each round's review.

`auditOnce` is not exported any more: one turn without a record or a stopping
rule is not an audit in this repository's sense, and it had one caller.

## Asking the user, and touching the world

Two ports, one rule: **the agents produce text, our code performs the act.**

- `src/ask.ts` - `AskUser`, one question at a time. The pi implementation is a
  select card (`extension/ui/ask.ts`), an example uses readline, the tests use a
  scripted array. Returning `undefined` is the **submit**, not a cancel: what was
  already answered still counts, and the brief is still written. `esc` maps to it
  for the same reason.
- `src/verify.ts` - `Verify`, a command we run with `execFile` and no shell. Its
  output is evidence the agents read and cannot argue with.
- `src/git/git.ts` - the git a pipeline may do, as functions. There is no
  `push`, no `reset`, no `rebase`, no `--force`, and no shell: arguments are
  arrays and the commit message is piped to `git commit -F -`, so a message
  containing `rm -rf /` is committed rather than executed.

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

## A check the auditor contradicts goes out with the fix

The auditor is handed the check's command and its output, and it can still
write the opposite. Measured on a delivery that worked: four green tests, then
`"Test file has a syntax error causing failure."` and a fix raised for it, and a
round spent rewriting a file that was fine. Audit 2 approved. Every honest
signal was there and none of them stopped the round.

Three ways out, and the middle one is the one taken.

- **Drop the fix.** It needs us to read the auditor's prose for a claim about
  the check, and a false positive there throws away a real remark. Guessing at
  meaning is what the verdict tool exists to avoid.
- **Send the evidence with the work.** Every audit fix carries one line saying
  the check passes on the tree it is about to change, so a worker sent after a
  failure that is not there settles it by reading instead of by rewriting. The
  remark still reaches the worker exactly as the auditor wrote it, which is what
  keeps a real fix from being lost to a heuristic.
- **Say nothing and pay the round.** That is what the measurement cost, and the
  round is not the whole of it: the rewrite lands in the tree and the next audit
  reads a file nobody meant to change.

The audit prompt now states the passing case with the same force as the failing
one, which was already there: a fix is asked for because the code is wrong, not
because something fails. That sentence is not the mechanism, though. Invariant 7
holds here as everywhere - the prompt asks, and the evidence travelling with the
fix is what a worker cannot talk itself out of.

A **failing** check is not attached. It is what the fix is for, and the suite
says so the moment the worker runs it.

## Resuming a build

A delivery is long, it costs money and it writes to a working tree. `deliver`
therefore takes `onProgress` and `resume`, and
`src/workflows/deliver/resume.ts` turns the one into the other through
`runs/<timestamp>/build.json`.

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

### The shape of a message is read where the pi API lives

Two readers in `subagent.ts` knew what a pi message looks like: one walked the
content parts of the last assistant message for its text, the other read its
`stopReason` and `errorMessage` for the failure a turn can end on without
throwing - the trap `AGENTS.md` lists. The event subscription beside them cast
a `SessionEvent` to reach `assistantMessageEvent`, `toolName` and `args`, though
`session.ts` declares that very union. The fake session then had to reproduce
the same shape for those readers to read. Three places knew pi's shape; the
invariant names one.

`lastTurn(messages)` and `streamed(event)` are the two readings, in
`session.ts`: what the last turn said and how it ended, and what a streamed
event means to a listener - a piece of the answer, a tool being called, or
nothing. `subagent.ts` reads a text, an error and two kinds of event, and
holds no cast. The casts themselves did not go: the union keeps a `{ type:
string }` member so that pi's own listener type satisfies the port, and that
member is what stops narrowing; they sit where the shape is known, with the
reason. The fake still builds pi-shaped messages, because it stands in for pi,
and the two readings are asserted against that shape once, in
`test/session.test.ts`.

The port itself did not grow a method. `createDefaultSession` hands back pi's
`AgentSession` as it is, which satisfies the port structurally; a method of our
own would have meant a wrapper proxying every member for the sake of one.

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
  never estimate it. And what a provider reports changes: one that reported
  nothing at all now reports tokens, so a provider's counters are worth
  re-measuring rather than reading off a list.
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
skills: diffing             # our own extension: an allowlist, like tools
model: anthropic/claude-sonnet-5
lifetime: workflow          # our own extension: default lifetime
---

You review the code produced and return at most 5 remarks…
```

- `name` and `description` are **mandatory**; a file without them is ignored
  silently (pi's behaviour, we keep it).
- `tools` and `skills` are read the same way: a comma-separated line or a YAML
  sequence, and a field with nothing after it names nothing rather than
  something empty.
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

### Every subagent answers in the language it was given

Asked in French where the wall time is measured, `/step scout` answered in
English. No definition asks for English; they inherit it from the prompt around
them, which is English like everything written into this repository. The person
who asked then reads their own repository through a translation they never
asked for.

So the instruction is standing, in `src/language.ts`, appended to every system
prompt beside `situate()`. One place, and it reaches an agent a user wrote
without ever thinking about the question - which a line added to the nine
definitions here would not.

**It is said twice, and the second time is where it lands.** The system prompt
was enough for a single task and stopped being enough as soon as a combinator
framed one: a swarm tells each member which round it is, what is new on the
board and what is still free to take, and all of that arrives in the *same
message* as the goal, which a model weighs far above anything standing behind
it. So `ask()` closes every turn with the rule again, in one sentence - short,
because repeating three would spend a paragraph of context saying what one line
says. Measured on `ilaas/gpt-oss-120b`, a French question put to a swarm of two
over two rounds, counting the board posts that came back in French:

| | standing rule alone | with the closing line |
|---|---|---|
| the wording that disowned only the prompt | 3 of 18 | 9 of 35 |
| the wording that disowns the framing too | 5 of 19 | 62 of 89 |

Neither half carries it, which is why neither can be dropped as a tidy-up. `ask()` is the one funnel every turn
of every workflow goes through, so a combinator cannot forget it and a workflow
somebody else writes gets it for free; the event stream still reports the task
its caller wrote, since a card drawing the line back would show a reader
something they did not write.

**It points at the work, not at the prompt.** The first wording said "the
language of the task you are given", and measured on a small open-weight model
that loses the case worth having: a reviewer whose French goal is wrapped in
English scaffolding ("Review this work.", "It was asked to:") answered in
English, because most of the task really was English. Naming the material
instead - the request, the specification, the report of another agent - and
saying outright that these instructions never decide it, turned the same run
French.

**And it names no language.** The wording that fixed the reviewer did it with an
example: *if the work you were handed is in French, answer in French*. The next
English question came back in French. In a standing instruction an example reads
as the target, and this one is in front of the model on every turn of every
agent, so the rule now says that no example in it decides the language either.
Three turns settle it, and they are the check to re-run on the day the sentence
is touched: an English task answers English, a French task answers French, and
French work inside English scaffolding answers French.

**What must not move is exempted by shape.** A model writing French writes
`PRÊT` for `READY` and `RAS` for `LGTM`: a loop that never converges, a review
nobody can parse, and no error anywhere. The library could list its own
sentinels, but a workflow somebody else writes has its own, so the rule is
written as a shape: a word you were told to answer with, a JSON key, an agent
name, an identifier, a path, anything quoted from code. Measured, on the same
model: a French task asking for `LGTM` alone returns `LGTM`; the router answers
`scout`; the planner answers valid JSON whose `task` strings are French, which
is right, since they are the work the next agent reads.

The interview keeps its own per-turn reminder. It is the one prompt that can
name its exemptions exactly, and it pays the most for losing them.

## The model: an explicit knob at every level

For a long time the model was the one thing invariant 5 did not cover, and it
was measured: agents with no `model:` ran on the operator's
`~/.pi/agent/settings.json` defaults (a model the caller had never named, 402s
inside a session started with a different provider, `thinkingLevel: high` nobody
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
nothing specified put all four subagents on a model named nowhere in this
repository, read from `~/.pi/agent/settings.json`. An earlier run picked up a
`thinkingLevel: high` nobody asked for the same way.

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

## A board, if there is to be one, is append-only and stamps its own names

Everything else here passes `Result`s between subagents that never meet. A board
is the other arrangement, and it is worth having only if a run that used one can
be read back afterwards exactly as it happened. That is what fixes its shape
before anything is built on top of it.

**Nothing is rewritten and nothing is deleted.** A member can add to the record,
and that is the whole of what it can do to it. The record is the only thing that
says what happened, so a run able to edit it is a run that cannot be
investigated.

**`from` is stamped by the board, never carried in the draft.** The caller says
who is posting. `Draft` has no such field, and a model that sends one anyway is
not believed - there is a test for exactly that, and it is the load-bearing one
of the file. Identity that can be claimed in a parameter is what makes a medium
one where any member can speak as any other, and no prompt repairs that
afterwards. The same rule as "only whoever raised an obligation may close it".

**All three caps have defaults**: 200 posts, 2000 characters each, 50 per
member. Not because those numbers are right, but because a medium with no cap is
bounded by the deadline and nothing else, which is the same reason
`maxIterations` defaults to 5.

Three smaller things, each one a fork that could have gone the other way:

- **A refusal is `{ ok: false, error }`**, the shape `Ledger.close` already
  returns, rather than a post-or-error union a caller can mistake for a post.
- **`to` names a member, not a topic.** A board that cannot tell the two apart
  cannot refuse an address that reaches nobody, and `kind` already carries what
  a topic would have. A board told no members accepts any address: refusing one
  it cannot check would be guessing.
- **A reader is not handed its own posts.** It wrote them, they are already in
  its context, and the point of the cursor is to spend as little of that as
  possible.

**Reading is announced as loudly as posting**, and that came out of running it
rather than out of designing it. Three members dividing one job posted their
claims 1.5, 3.1 and 3.5 seconds in, so the later two could have read the earlier
ones before choosing - and nothing in the record said whether they had. Posts
answer who said what. An investigation asks who *knew* what, knowing comes from
being handed something, so being handed something is an event: `read` carries
the ids delivered and how many were left waiting. The empty read is recorded
too, being the only thing that settles what a member could not have known.

### The medium announces, whoever acts on it

The tool announced. A member's post, its read and its take went onto the bus
from `board-tool.ts`, and the decision above said reading was announced as
loudly as posting. The swarm, meanwhile, read the board itself at the top of
every round to hand each member what it had not seen, and took back what a
member that had stopped was holding, and neither act was on the bus: the
handout that fed every round was in nobody's record, and the console, the board
pane and `events.jsonl` showed the half of the traffic that went through a
tool. The code was behind the decision, not against it.

`src/board/announced.ts` wraps the medium: `announcedBoard` and
`announcedClaims` return the same `Board` and the same `Claims` with every act
on the bus - an
accepted post, every read with the ids it handed and how many it left waiting,
every grant and refusal, and one release per key for a member that is gone. The
swarm wraps what it was given or what it made, once, and hands the wrapped
medium to the tool and to itself. The tool announces nothing any more.

Wrapped at the swarm rather than built in: a caller hands the swarm a board to
read afterwards, and `/swarm --claim` builds its claims with no bus in reach.
A bus baked into `createBoard` would have left both silent. `board.ts` and
`claims.ts` stay the pure data their headers promise.

Paging moved into the board with it. `since(reader, cursor, limit)` hands back
a page, says how many wait, and moves the cursor past what it handed and never
past what it merely looked at - which the tool used to do on its own after the
fact. A `read` event has to say what was handed over, and only the one that
decides the page can say it.

## A claim is granted, never announced

A board lets a member say what it is taking, and that turned out not to be
enough in the first run that recorded reading. Three members read within 123ms
of each other, each was handed nothing because nobody had posted yet, and all
three then claimed the same file. Announcing into a medium that was empty when
you looked is a race, and no prompt repairs a race.

So `claims.ts` arbitrates: first to ask holds it, and everyone else is refused
and told who holds it. The refusal is the useful half: "`src/parser.ts` is held
by scout#3 - ask scout#3, or take something else" turns contention into somebody
to talk to, where a silent loss turns it into two members doing one job.

**The keys are a list, not free text**, and that is the part the same run
argued for: one file came back as `console.ts`, `src/reporters/console.ts` and
`I will handle src/reporters/console.ts`. A lease keyed on what a model writes
would have granted all three and arbitrated nothing. A caller that knows what
there is to claim passes the list, and a key that is not on it is refused with
the list - the discipline `delegateTool` already applies to an agent name. A
caller that cannot enumerate the work passes nothing and gets the weaker
behaviour, which is honest rather than convenient.

**How much one member may hold is a knob, and the number came from a run.** With
nothing bounding it, one member of three took all six keys and the other two
spent their turns being refused. Three arms, two repetitions each, same model,
same goal:

| | most held by one member | grants | mean wall | ↑input |
| --- | --- | --- | --- | --- |
| nothing | 3, 4 | 10.5 | 41.2s | 394k |
| a rule in the prompt | 4, 4 | 11.0 | 43.2s | 434k |
| `maxPerMember: 1` | 1, 1 | 14.5 | 53.3s | 646k |

The middle row is the one worth keeping. "Take one thing at a time, and release
it before you take another", written into the member's own definition, changed
nothing at all: four held at once, exactly as with no rule. That is invariant 7
in its own words - a prompt is not a permission boundary - measured for holdings
rather than for tools.

The bound works and the work still goes round: more grants, not fewer, because
members cycle through take, do, release instead of sitting on everything. It is
**not the default** because it is not free: 29% slower and 64% heavier in input
tokens, since taking, releasing and being refused are all calls. A caller with
no contention should not pay for it.

Two smaller ones:

- **Taking what you already hold is granted.** It is not contention, and a
  member told "you cannot have it, you have it" learns nothing from being
  refused.
- **`releaseAll(member)` returns the keys it let go**, because a member that
  dies holding claims leaves work nobody will do and nobody can take. The run
  says which ones rather than leaving a reader to notice the gap.

The same three members, the same job, with `take` on the tool:

```
   +693ms member#3 take console.ts -> granted
  +1063ms member#2 take console.ts -> refused (member#3)
  +1675ms member#2 take herdr.ts   -> granted
  +3081ms member#1 take console.ts -> refused (member#3)
  +3711ms member#1 take record.ts  -> granted
```

All three went for the same file again, which is the point: the models did not
change, the medium did. Both refusals were absorbed on the next call, inside the
same turn, and three different files were described in half the wall time of the
run that collided. Nobody posted and nobody read: arbitration made the
announcing half unnecessary for this job, which is worth knowing before anything
is built on the assumption that members talk.

## A swarm is built to be compared against not having one

Every other combinator decides who does what. A swarm decides none of it, which
makes it the one whose value is an open question rather than a design. So it is
built to lose honestly: **with no board, no claims and one round, `swarm` is
`fanOut`**. That degenerate case is a test, and it is the control arm of any
experiment run with it - the board's worth is the difference between the two, on
the job you actually have, and not an argument.

Three things are decided in the combinator rather than left to a prompt, each
one from a run that happened before it was written:

- **Members remember.** `lifetime` defaults to `"workflow"` here and nowhere
  else. A member that forgets the round before cannot build on what it saw, and
  a swarm of amnesiacs is a fan-out that costs more. `"task"` with more than one
  round is refused outright: a member's id is its name on the board, and a
  task-lifetime member gets a new one every round, so from the second nobody
  would be talking to who they think they are.
- **What is new is handed over, not fetched.** Measured: once something
  arbitrated, members stopped reading the board entirely - they take, they are
  refused, they take something else. Charging them a call to learn what the
  workflow already knows is charging them for its bookkeeping.
- **A member that is gone holds nothing.** Measured: two of three members never
  released what they took and were still holding after they closed. Claims left
  by a member that is gone are work nobody will do and nobody can take, so the
  swarm releases them and the result says which.

`stoppedBy` is separate from `ok` and from `converged`, for the reason `loop`
separates them: a swarm that ran out of rounds did not succeed, it stopped.

## A swarm reaches pi as a step of the chain

`/run` leaves its answer in the conversation, because an exploration is read and
then asked about. A swarm's answer is not one report: it is what every member
said plus the board they said it on, and in a real run that is a screenful. Put
in the conversation it would be an orchestrator's brief that nobody asked for,
so `/swarm` does what `/step` does - recorded in the relay, drawn in the
transcript, out of the model's context until `/quote`.

That reuse is the whole design of the command. The relay gained a third `kind`
and nothing else: `/chain` lists a swarm, `/quote` brings it in, `/step --from`
carries it on, and the entry renderer already knew how to draw a step.

**`--claim` also gives the run something to be finished by.** With things named,
the swarm stops once each of them has been reported on, rather than spending
every round it was allowed. Measured in a real pi, three members and three
files: 3 rounds and 9 turns with the cap alone, 1 round and 3 turns with the
condition, and three of the first run's six posts described a file another
member had already described. A round cap bounds the worst case; it is not a
plan. With nothing named there is nothing to be done with, and the rounds are
all there is.

**`--until agree` is the other way to be finished, for the jobs that do not
split.** Coverage is a test on work: every named thing reported on. A question
put to three members has no named things, so the only end it has is the three of
them saying one thing. The condition reads the roster rather than whoever spoke,
because two of three agreeing is not agreement, and a member that dropped out
therefore never lets it fire - the run spends its rounds and says so.

The vote is a line, `VOTE: <answer>`, and the sentence asking for it is appended
to the goal by the command. Two alternatives were weighed. A JSON shape would be
parsed more exactly and comes back fenced or explained from a small model, where
a line is what one writes correctly on its first turn. Putting the request in an
agent definition instead would have every other run of that agent posting a vote
nobody counts, and would miss any agent a user writes. So the instruction lives
beside the parser that reads it, in `src/board/agreement.ts`: told in one file
and read in another, the two drift the first time either is edited.

Measured in a real pi, three members on one question: 3 rounds and 9 turns with
the cap alone, 1 round and 3 turns with the condition. What they agreed on is
the part worth reading - all three read the repository they stood in and voted
for its language, which is agreement about a fact rather than an argument
anybody won. Copies of one model share its opinion, so a swarm asked to debate
has to be handed its disagreement, and `--claim` is what hands it out: the camps
are leased one owner at a time, and the vote stays free every round.

**An agent that does not name `board` is run anyway**, with a word saying its
copies cannot reach each other. That is a fan-out, which is precisely the arm a
swarm has to be compared against, and refusing it would remove the control from
the one place someone can try it in a second.

## A directory is a module, and its index is the door

`src/` had thirty-nine files at its root, and the ones that formed a module
together said so only in their headers: `scratch.ts` names `worktree.ts`,
`board-tool.ts` sends the reader to `announced.ts`, `settle.ts` says it is
"what `deliver` does with" `land.ts`. A reader who wanted one concept opened
five files, in the order the headers pointed, out of a flat listing that gave
no hint which five.

The rule: **files whose headers name each other sit in one directory, and its
`index.ts` is the only file anything outside imports**. What the index lists is
the module's interface; what it does not list is implementation, and the
directory is what makes that distinction visible in a listing rather than in
prose. Tests are the one exception, and a deliberate one: they reach past every
door, so a helper exported for a test never has to appear on an index.

Two things about the generated reference made this cheap. `npm run docs` follows
`export … from` transitively and names each page after the **declaring** file,
so re-exporting a directory's index from `src/index.ts` changes nothing on the
public surface and moves the module's pages under its directory. And the
reference's toctree is generated, so a page that moves takes its navigation
with it; only the hand-written links in `docs/guide/` have to follow. What a
move cannot lean on is a test: two constants compute a path from their own
depth, `PACKAGE_ROOT` in `builtin.ts` and the pane's entry in
`reporters/herdr.ts`, and nothing offline reads either. That is why
`builtin.ts` stays at the root whatever moves around it.

### The delivery owns its git policy and its saved state

The first module to become a directory was the one whose two files pointed the
wrong way. `resume.ts` sat at the root and imported four files from
`workflows/` - `audit`, `deliver`, `pair`, `plan` - while none imported it back:
every arrow left the root and went down. `settle.ts` sat in `workflows/` and
was not a workflow by this repository's own definition - it takes `{ cwd,
worktree, writers, verify }`, no `spawn`, no lifetime, no signal - and its
header said whose it was: "this is what `deliver` does with it". They are also,
with `pair.ts` and `audit.ts`, the most edited files under `src/` after the
barrel and `subagent.ts`, and `deliver` and `pair` change together in most of
those commits.

`src/workflows/deliver/` now holds the combinator, its two stages, `settle.ts`
and `resume.ts`. Its index lists what the barrel and `pipeline-run.ts` reach:
`deliver`, `pair`, `audit`, the saved-build functions, and the two `settle`
types a `DeliverOptions` names. `settling` itself is not on it; the delivery is
its one caller. `plan.ts` stays in `workflows/`, because `orchestrate` plans
too.

### The extension: commands, the terminal, and the floor

`extension/` had twenty-two files at one level, and the suffix was doing the
directory's job: six ended in `-command`, two in `-ui`, and `build.ts`,
`stop.ts`, `commit.ts` and `stage.ts` carried nothing, so a reader could not
tell a command from what it stood on without opening it. `src/stop.ts` and
`extension/stop.ts` were unrelated files with one name, told apart only by
their tests being called `stop.test` and `stop-ui.test`.

The split follows what a file does with pi. `commands/` holds every file that
registers a slash command, plus the two helpers only one command uses -
`commit.ts` for `/build`, `stage.ts` for `/step`. `ui/` holds what paints or
reads the terminal without registering anything: the live view, the question
card, and the two module-level switches a card and a key share. The root keeps
the floor - `pi.ts`, `deps.ts`, `command.ts`, `flags.ts`, `params.ts`,
`relay.ts` - with `index.ts` and `execute.ts`, because the tool is what the
extension *is* and the floor is what every command stands on. The suffixes
went with the move: the path now says what the name used to.

Two type-only cycles between the floor and its leaves went at the same time,
because a directory makes an arrow's direction visible and both pointed up.
`pi.ts` imported `ExecuteDeps` from the tool body to type what it handed the
tool; `ToolDeps` now lives in `pi.ts`, as the slice of pi's context the tool
reads, and `execute.ts` widens it with what a test may replace. `deps.ts` and
`relay.ts` each held one half of `AppendEntry`; the relay owns the entry a step
leaves, so it owns the door it leaves it through as well.

One arrow still crosses from `ui/` into `commands/`: the live view tells `/stop`
which run is on screen. That is the sign that `stop.ts` holds a key and a
command at once, and it is left in view rather than papered over.

### The board is one module with one caller

Five files at the root of `src/` - `board.ts`, `claims.ts`, `announced.ts`,
`board-tool.ts`, `agreement.ts` - had one caller inside the library,
`workflows/swarm.ts`, which imported nine names from four of them. Their headers
already read as one text: `claims.ts` calls itself "pure data, like `ledger.ts`
next door", `board-tool.ts` sends the reader to `announced.ts` for the bus, and
following "a member claims a file" meant four files in the order the headers
pointed. `agreement.ts` is a policy over a `Board`, the way `settle.ts` is a
policy over `land`, and its one caller is the `/swarm` command.

`src/board/` now holds the five, `board-tool.ts` renamed `tool.ts` since the
directory says whose. Its index lists what `swarm` builds and hands out, and
the vote the command reads; `latestVotes` stays behind it, counted only by the
agreement. The one arrow into the module from the core is `events.ts` naming
`Post`, because a board's traffic is an event like any other; a directory makes
that arrow readable where a flat listing hid it.

### Running a pipeline is not a combinator

`pipeline-run.ts` sat in `workflows/` and was the one file there that depended
on every neighbour: it imported the eight combinators and dispatched on a
step's `kind`, returned a `PipelineRunResult` rather than a `Result`, and
composed with nothing. Every other file in the directory depends on
`options.ts` and `pool.ts` and on nothing sideways. Its own header said what it
was: "our code walks the steps". Meanwhile `pipeline.ts` and `pipeline-load.ts`
sat at the root, two of the three stages of one thing, in a listing that put
`ledger.ts` between them.

`src/pipeline/` now holds the three in the order they are used - `pipeline.ts`
reads the file, `load.ts` finds it, `run.ts` walks it - and `workflows/` holds
only combinators again. `builtin.ts` stays at the root on purpose: its
`PACKAGE_ROOT` is two `dirname`s up from its own file, so a move would point
the shipped `agents/` and `pipelines/` at `src/` and nothing offline would
notice; the layout block now says what it is for, so the next reader does not
try.

### The working copy is a stack, and reads as one

`git-run.ts`, `git.ts`, `worktree.ts`, `scratch.ts` and `land.ts` were a stack
that said so in every header - "`git.ts` covers the repository; this covers the
copies of it", "`worktree.ts` holds the primitives; this holds the one shape
every caller wants" - and sat at the root of `src/` with `ledger.ts` and
`language.ts` between them. `src/git/` now holds the five, `git-run.ts`
renamed `run.ts`, and its index lists what leaves the directory: the git a
pipeline may do, the landing, the scratch copy `pair` opens, and the worktree
primitives. `run.ts` is not on it; running git is the how, and everything
outside asks what.

Two things did not move, each for a reason worth keeping. `verify.ts` is a
port, beside `ask.ts` - its header says so - and seven files depend on it that
have nothing to do with git; putting a port under a mechanism would read the
dependency backwards. And the worktree primitives stay on the public surface
although only `scratch.ts` calls them inside the library, because the
worktree guide teaches them in its first code block; the rule for the surface
is what somebody outside calls, and a guide is somebody outside.

### The review record's door was already in the barrel

`review.ts` said in its header that it was "the one place that joins" the
verdict and the ledger, and the code agreed: `verdictTool`, `declaresVerdict`,
`createLedger` and `openList` had no caller but `review.ts`, and the barrel
exported the types of all three files and the function of one. The interface
was visible everywhere except in the listing, where the three sat among
thirty-nine files with `resume.ts` and `run.ts` between them.

`src/review/` now holds the three, and its index lists what the barrel already
did: `reviewRecord` and the types a result names. Its three callers are the
delivery - `pair`, `audit`, and `resume` for the types - which is why it could
have gone under `workflows/deliver/`; it did not, because a verdict as a tool
call is one of the three tools combo hands a subagent, beside the board's and
the delegation's, and that family reads better from the root. `tool.ts`, the
words those three share, stays at the root for the same reason.

### Measuring is a chain, and `usage.ts` is not a link of it

`export.ts`, `measured.ts`, `experiment.ts` and `experiment-report.ts` were one
chain - a run directory, a run that measures itself, the same run over M models
and N times, the matrix read back - split across the root of `src/` by
alphabetical accident. `src/measure/` now holds the four, `experiment-report.ts`
renamed `report.ts`, and its index lists what the extension's live view, the
examples and `spawn` reach. The chain had one back-edge, `experiment.ts`
importing its report and the report importing `ExperimentOutcome` back; the
outcome now lives with its reader, and the module reads in one direction.

`usage.ts` is not in it, although the word suggests so. It is what `Result`
and every event carry, imported by fifteen files including `result.ts` itself;
a `measure/usage.ts` would have the core reaching into a feature directory for
its own currency. The one arrow that does run from the core into this module,
`spawn` calling `exportSession`, is the honest one: a subagent's transcript is
exported where it is still in hand.

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

### A value is public when somebody outside calls it

The two rules decided types and test helpers, and said nothing about a value
nobody called. The file was touched in twelve of twenty-five commits, every
time to add, and of 168 exported values 75 were referenced by nothing in the
extension, the examples or the scripts: every prompt builder, the word
constants, the four working-copy layers, the record and the ledger, the board
and its announcing wrappers, the mirror, the event bus, the pipeline directory
constants. The list had become a measurement of feature count. A reader
learning the surface learnt a third of it for nothing, and the generated
reference documented it.

The third rule: **a value is public when somebody outside `src/` calls it** -
the extension, an example, a guide's code block, or the TSDoc of a public option
that names it as the default a caller may wrap (`formatBranches` for
`ReduceOptions.format`, `pickDestination` for `RouteOptions.parse`). Two more
were kept on the same footing although the rule as computed missed them: the
guide for writing a combinator tells its reader to open a `Trail` and to compose
offers with `offerBoth`, and the file's own comment names `createDefaultSession`
as what a caller wraps to reach pi's session. `succeeded` stays as the pendant
of `failed`.

Forty-seven values left: `announcedBoard`, `announcedClaims`, `boardTool`,
`BOARD_TOOL`, `verdictTool`, `declaresVerdict`, `VERDICT_TOOL`, `SUBAGENT_TOOL`,
`reviewRecord`, `createLedger`, `openList`, `latestVotes`, `scriptedAsk`,
`busFor`, `createEventBus`, `experimentReport`, `writeExperimentReport`,
`copyMainSession`, `exportSession`, `applyPatch`, `currentBranch`, `headSha`,
`landable`, `scratchWorktree`, `settling`, `answerInTheirLanguage`,
`inTheLanguageOfTheWork`, `ANSWER_IN_THEIR_LANGUAGE`, `mirrorSocket`,
`registerMirror`, `REFUSED_IDLE`, `loadPipelinesFromDir`, `PIPELINES_DIR`,
`STEP_KINDS`, `abortError`, `loadBuildState`, `BUILD_STATE_FILE`, `skillDirs`,
`accumulate`, `snapshotUsage`, `AUDIT_APPROVAL`, `auditPrompt`, `answerPrompt`,
`briefPrompt`, `questionPrompt`, `remarksPrompt`, `makePlan`. Every one is still
exported by its own file and reached by its tests there; what changed is what a
reader is told they may call. The one reference page whose module kept no public
symbol, `announced`, went with it, and no guide linked to it. The day a script
needs one of these back, the rule says how: show it in a guide, or call it from
an example.

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

combo had no drawing of its own. It has one now: **three bars, one bracket** -
the bars identical and in the ink, because a fan-out has no favourite branch,
and the bracket in verdigris, because holding the three as one is the claim of
the library. `docs/_static/logo/README.md` holds the palette, the file table and
the two rules that are easy to get wrong: a two-tone drawing needs a file per
ground, and `currentColor` never reaches an SVG referenced as an image.

**The bracket replaced the first mark, three strokes in, one out.** The strokes
read as a generic merge glyph, and their curves closed into a blob below 24px.
Of the directions compared against it, the bracket is the one that states the
library plainest - three equal things made a group by one device - and the only
one legible at 16px with a single geometry, in rectangles only, which is
trysquare's vocabulary. The proposal drew that bracket in brass; here it takes
verdigris, because the accent is the identity and brass is trysquare's.

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
