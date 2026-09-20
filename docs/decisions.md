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
file, `src/verdict.ts`.

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

Everything a reviewer raises becomes an **obligation** in `src/ledger.ts`, with
an id combo assigns and that never changes. Finished means the reviewer has
nothing further to ask *and* nothing it raised is still open.

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

### A command picks the deadline the library refuses to

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
  `liveRun` in `extension/run-ui.ts`: two call sites, two timers and two ways of
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
in `extension/stop.ts` holds the stop for the length of a question, free-text
box included, and `escape` falls through to pi as before. Held rather than
dropped, because the run's subagents are idle while a question waits: there is
nothing running that the key would have been pressed to call off. The other
way round - making the card's `esc` a cancel, so that both meanings agree - was
rejected, because it throws the answers away, and the reflex to escape out of a
dialog is exactly the moment those answers are worth keeping.

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
beside the parser that reads it, in `src/agreement.ts`: told in one file and
read in another, the two drift the first time either is edited.

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
