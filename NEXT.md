# What is left

Written to be picked up cold. `AGENTS.md` holds the decisions and the pi API
notes; this file holds only what has not been done yet, and the traps already
paid for. Every section says what was measured rather than what was intended,
so a number here can be checked by running the thing beside it.

State: offline tests green, clean typecheck.

Shipped: the foundation (`Agent`, `Subagent`, `Result`, `Usage`, event bus),
ten combinators (`chain`, `fanOut`, `loop`, `reduce`, `route`, `orchestrate`,
`interview`, `pair`, `deliver`, `swarm`), four reporters (herdr, TUI, console, silent),
the session export, **pipelines** (a workflow written in Markdown, discovered in
`~/.pi/agent/pipelines` and `.pi/pipelines`), and a generated and test-enforced
`docs/`. A subagent whose own definition asks for it **delegates in turn**, two
levels deep unless told otherwise, with a worktree per writing child, a ledger
in place of a stop word, and a measurement shaped like the tree it came from.

Several subagents can also work **one job side by side**: an append-only board
that stamps who posted, claims granted rather than announced, and `swarm` above
the two. Section 10 has what running it said.

The pi extension is the `subagent` tool plus `/interview`, `/build` (unattended,
with `resume`, `--pipeline` and `--check`), `/run`, `/step`, `/chain`, `/quote`, `/agents`,
`/pipelines`, `/herdr` and `/stop`. A run can be **called off while it runs**:
`esc` stops every subagent of it, `ctrl+↑↓` walk the list above the prompt and
`ctrl+del` stops the selected one. What comes back is in **the language the work
was written in**, whatever language the definitions are.

All four founding requirements of `AGENTS.md` are met, and the end-to-end flow
(request → plan → worker/reviewer pairs → check → audit → an uncommitted working
tree) runs with nobody asked anything. What follows is judgement and polish.

## 1. Judge the interactive rendering - looked at, and acted on

The frames have been read, by machine. `scripts/drive-pi.py` types into a real
pi through a pty and prints what it painted, which is how the widget, the
indent under a delegating subagent, the stop keys and what `/stop` answers were
checked. It earns its keep: it found a selection left pointing at a subagent
that had finished, and a message claiming the run carried on when the pipeline
step had just ended. Neither was visible to a fake.

What it could not do was judge, because printing strips the escape sequences:
spacing, colour and density were never in what it showed. `scripts/frame.py`
replays the same log through a terminal emulator and draws the screen, so they
are now in a picture instead. **The question card has been looked at**, on
2026-09-19, against pi 0.85.1 at 45x120 with the subagents on
`ilaas/gemma-4-31b`. Four things came out of it, and all four have been
answered since.

- **Option descriptions were cut mid-word.** On a 120-column terminal the card
  showed `…by checking file modification times before r`, because pi-tui's
  `SelectList` truncates a description to the remaining width with an *empty*
  suffix: the cut carries no ellipsis and nothing says anything was lost. The
  lever was the interviewer rather than the card, which goes on taking whatever
  an agent wrote, and its definition now asks for about sixty characters.
- **`esc` said two things at once**: `esc stops everything` above the prompt and
  `esc build with what you have` on the card, on screen together. The card owns
  the key while it is up.
- **A fan-out did not read in launch order.** Three scouts drew as `scout#2,
  scout#1, scout#3` and stayed that way. `spawn` takes the id synchronously but
  emits the event only after `await createSession()`, because the event carries
  `modelLabel(session)`, so rows landed in the order sessions became *ready*.
  The counter rides on the event now and the widget inserts by it.
- **The two standing entries read as two more answers.** `Other…` and `That's
  enough - build it` sit in the same column and the same style as the agent's
  own options, and `SelectList` has no separator to put between them. Decided:
  live with it, and revisit if anyone is ever seen answering "That's enough" by
  mistake.

The density question is answered and done: seven lines for three subagents is
not too much while they run, but the second line of a *finished* one held its
last tool call, which nobody needs any more. A finished subagent now takes one
line with its numbers beside the tick, so the widget shrinks to four as the
three finish instead of holding the terminal at its widest.

Looking again at the frame that came out of that change found one more, and it
was not in the widget: pi sends a `tool_execution_start` whose `toolName` is the
**empty string**, so a row read `path=test/tui.test.ts offset=318 limit=30` with
no verb. Measured, one call in four on `ilaas/gpt-oss-120b`. The trap is in
`AGENTS.md` now: `|| "?"`, never `?? "?"`.

```bash
pi -e extension
/interview add a cache in front of the agent loader
/herdr on                                  # a split per subagent, to watch it work
/build --check "npm test" add a slugify helper with tests   # in a throwaway repository
/build --pipeline explore how usage is measured
/build resume                               # after interrupting one
/step explore how usage is measured         # then /step planner, /chain, /quote
/run explore how usage is measured          # then ctrl+↑↓, ctrl+del, esc
```

**The step entry has been looked at**, and it did not read at a glance. The
header said `not in this conversation, /quote puts it there` in the same muted
grey as the turn count, above a report drawn flush left at full width - the way
an answer the session gave is drawn. Everything on that screen was louder than
the one line saying the session had not read any of it.

Two changes, both judged from the frame rather than from the assertion: the
phrase takes the theme's warning colour, so it separates from the cost beside
it, and the body is indented two columns, so the block reads as an aside before
a word of it is read. The notification below it is untouched, because a
tutorial quotes it.

What that leaves: the same frames on a real terminal, where the face and the
theme are the user's own rather than the palette `frame.py` assumes.

## 2. The pipeline is only as good as its worker - answered

The machinery was verified on a throwaway repository against
`ilaas/qwen-3.6-35b-instruct`: the plan was made, the pair converged, the check
caught a failing test, the auditor named the fix, the fix ran, the check ran
again, and the run ended `NOT approved` rather than shipping something broken.
That last part is the machinery working.

What it also showed: a weak worker flip-flops - it "fixed" an import by
reverting the previous fix. Nothing in `deliver` can repair that, and no prompt
will.

Run again on 2026-09-19 with two larger models, `examples/11-build.ts` on a
throwaway repository, same brief both times ("add a `truncate(text, max)` helper
that cuts on a word boundary and appends an ellipsis, with tests"):

| model | what came out |
| --- | --- |
| `ilaas/mistral-small-4-119b` | nothing on disk, both subtasks NOT approved |
| `ilaas/gpt-oss-120b` | delivered and approved: 11 turns, 142.6s, ↑211k ↓16k, 4 tests green |

**A bigger model is not the variable; tool calling is.** Mistral made real tool
calls for a while and then emitted `[TOOL_CALLS]ls{"path": "."}` as plain text
in the message that ended the turn, so pi ran nothing, the subtask "finished"
with that string as its answer, and the check passed because the tree was
untouched. Every honest signal was there (`NOT approved` twice, "nothing changed
on disk"), and none of them says *why*. A model whose tool calls arrive as prose
is unusable here whatever its size, and this provider serves one.

With `gpt-oss-120b` the whole flow worked: plan, pair, check, audit, fix, audit
again, commit message written from the real diff, and the delivered tests pass
on a clean checkout.

**The auditor's word against the check's is decided.** In that same run the
check passed with four green tests, and the auditor then wrote `"Test file has a
syntax error causing failure."` and raised a fix for it, contradicting output it
was holding in its own prompt. A round went into rewriting a file that was fine.

Dropping such a fix would mean reading the auditor's prose for claims about the
check, where a false positive throws away a real remark, so the evidence travels
with the work instead: every audit fix now carries the line that the check
passes on the tree it is about to change, and the audit prompt states the
passing case as plainly as it already stated the failing one. A worker sent
after a failure that is not there can settle it by reading. What is **not**
solved is the round itself - the turn is still spent, and only the rewrite is
avoided.

**A second thing came out of those runs.** Of seven deliveries, three ended
`NOT approved` with no fix raised and nothing on screen saying why. One of them
was read back from its transcript and settled it: the auditor answered
`approved: true` with `resolved: [{ id: "coder" }]`, an id it had invented; the
verdict tool refused the whole call; the auditor sent the same id again, was
refused again, and gave up into prose. An id nobody raised now drops out of the
verdict instead of taking the decision with it. The other two runs were not
exported, so they are the same signature rather than the same confirmed cause.

## 3. Distributing it as a package

Decided and done for the loading side: the extension ships `agents/` and
`pipelines/` and asks for them at the lowest priority, so `pi -e
../subagent/extension` in any directory now finds `scout` and `build` without
anything being copied. `AGENTS.md` records why that reverses the rule it
replaced.

The tarball is now explicit: `files` lists `src`, `extension`, `agents`,
`pipelines`, `README.md` and `docs` - 120 files, 204 kB, with `test/` and
`examples/` left out. What ships from `docs/` is the documentation and the marks
the README draws itself with; the machinery that turns those pages into a site -
`conf.py`, the Makefile, `requirements.txt`, `_pygments.py`, `custom.css` and the
vendored faces, 272 kB of them - is excluded by name, because an installed
package has no site to build. `npm pack --dry-run` is the check, and
`test/pipeline-load.test.ts` fails if `files` ever stops listing `agents` or
`pipelines`, which would break `/build` for every installed user while every
other test still passed.

What is *not* done is publishing. pi's `docs/packages.md` lists extensions,
skills, prompt templates and themes - agents are not on that list, so `pi
install` will not place anything in `~/.pi/agent/agents/`. It does not have to
any more, since the extension carries its own and asks for them at the lowest
priority. Nobody has run `npm publish`, and the name `combo` is unclaimed on the
registry as far as this repository knows.

## 4. Build the site once, and look at it

`docs/` is now a Sphinx site as well as a directory of Markdown: `conf.py`,
`_static/custom.css`, `_pygments.py` and the marks under `_static/logo/`.

```bash
uv venv && uv pip install -r docs/requirements.txt
.venv/bin/python -m sphinx -b html docs docs/_build/html -W
```

It **builds clean**, and `-W` earned its keep on the first run by naming two
defects nothing else could see. Ninety-three code blocks failed to highlight,
because `{ … }` is not TypeScript a lexer accepts - the generated signatures now
elide with `{ /* … */ }`, which is. And every "Source:" line pointed at
`../../../src/<module>.ts`, which resolves in a checkout and is dead on a site
that publishes `docs/` alone - they are absolute GitHub URLs now, read from
`package.json`.

**It has been looked at**, on 2026-09-19, in Chromium 153 at 1440px, light and
dark. Getting a browser to run took three things and none of them is obvious:
the allowance for `playwright.download.prss.microsoft.com` (the Chrome for
Testing path goes to `storage.googleapis.com`, still blocked, so the zip has to
come from the other mirror by hand), sixteen shared libraries from conda-forge
that the image does not carry, and a fontconfig with at least one font, without
which the renderer exits silently and writes no file.

The type answers its own questions. The Garamond at 1.125rem is not oversized,
the Inter section heads hold at 13px, the lockup works in the sidebar in both
themes, and the h2's short coloured rule is the good idea it looked like.

Two defects came out of it, both now fixed: a reference page's title was drawn
in a grey chip, because the heading reset that strips furo's code background
covered `h2`, `h3` and `h4` and not the `h1` that every generated page has; and
comments inside code sat at 2.94:1 against the block behind them in the light
theme, under the 3:1 a line of text needs at all, 3.60:1 in the dark one. They
take the palette's secondary ink now, 4.65:1 and 5.44:1.

**Two others did not survive being checked, and the reason matters more than
the findings.** I read the h3's rule as outweighing the h2's - sampled, the h2's
is `#c9d2d9` against the h3's `#dce3e8`, and longer. I read a signature block as
repeating the prose below it - it does not: the prose is the type's own TSDoc
and the block holds its members', which has nowhere else to go.

Both mistakes came from judging a downscaled screenshot by eye, and one of them
survived a second look at an image that had meanwhile been overwritten by the
fixed build. **What held up was measured**: a contrast ratio, a sampled pixel, a
diff between two captures taken with names that could not be confused. A picture
is what makes the question askable; it is not what answers it.

Still unseen: the mark at favicon size in a real tab, which a headless browser
has no tab for. Rendered from the SVG it does not hold at 16px - the three bars
merge into two - and that is section 4's remaining question rather than an
answered one.

**The marks have been looked at**, on 2026-09-19: `svglib` parses an SVG into a
reportlab drawing and reportlab writes a PDF, both pure python, and that page
rasterises. Three things came out of it.

- **The mark does not survive 16px.** In the tile at favicon size the three bars
  merge into two and the bracket reads as a blob; the counters between the bars
  are below a pixel. It is legible from 32px up. A favicon wants a variant with
  fewer, thicker bars rather than the same drawing scaled down.
- **The wordmark is much lighter than the mark.** The bars are solid blocks and
  "combo" is set in a near-hairline geometric sans, so at lockup size the mark
  carries the pair and the word reads as a caption under it. It holds better in
  the dark lockup, where the letters are pale grey against the verdigris.
- **The dark variants are right.** `combo-mark-dark` lightens the bars to pale
  grey and keeps the verdigris bracket; the light mark dropped onto a dark
  background loses its bars entirely, which is what the variant exists for.

None of that settles the mark, which is provisional anyway - see the paragraph
below.

The type in particular is set from numbers nobody has checked by eye. The pages
are in **EB Garamond** with **Inter** for the chrome, both served by the site
itself from `_static/fonts/` (`scripts/subset-fonts.py` regenerates them). Two
things to judge there: whether `article`'s 1.125rem carries the Garamond's small
x-height without looking oversized next to furo's chrome, and whether the section
heads - Inter 600, upper case, tracked - hold their own at 13px now that they are
no longer monospaced.

**The mark is not final.** The verdigris in `custom.css`, `conf.py` and
`_pygments.py` belongs to a drawing that was made here rather than chosen; the
one that was chosen lives in an artifact and has not been recovered yet. Expect
the palette to follow the mark, not the other way round.

`.github/workflows/docs.yml` - the first workflow this repository has ever had -
runs that same build on every pull request and publishes from `main` to GitHub
Pages. Two things it cannot do from a commit: the repository's **Pages source has
to be set to GitHub Actions** (Settings → Pages), without which the deploy job is
the only thing that fails, and someone has to decide whether the suite belongs in
CI too. `npm test` and `npm run typecheck` still run on laptops only; the docs
workflow regenerates the reference and diffs it, so a stale API page cannot reach
the site, and that is all it guards.

## 5. A child can be given a tool combo defines - answered

The probe ran on 2026-09-17, and it passes: the delegation tree is buildable
without any change to pi.

Measured against **pi 0.85.1** (the installed CLI) and **pi 0.80.10** (this
repository's `node_modules`), with identical results on both.

The route is not the `ResourceLoader` the plan guessed at. `createAgentSession`
takes **`customTools: ToolDefinition[]`** directly, built with pi's own
`defineTool`, and `StaticResourceLoader` keeps returning no extensions at all.
So the seam is one option on the call `src/session.ts` already makes, and
`getExtensions()` is left alone.

The gate holds, which was the half worth doubting. pi's `tools` allowlist covers
custom tools as well as built-in ones:

| agent's `tools:` | tool passed | result |
| --- | --- | --- |
| names `subagent` | yes | configured and active |
| does not name it | yes | **absent** |
| names `subagent` | no | absent |

So an agent that does not declare the tool cannot spawn anything, and that stays
readable in its file. Invariant 5's guarantee survives, and combo gets to gate it
twice: by not passing the tool, and by pi's own allowlist.

Registration is not invocation, so the last case was run for real: against
`ilaas/qwen-3.6-35b-instruct`, the model called the tool and the sentinel came
back through the transcript.

## 6. What stopping a run left open

`esc`, `ctrl+↑↓`, `ctrl+del` and `/stop` work, and were checked against a real
pi. Three things around them are known and unfinished:

- **`/stop` cannot be typed while a command of ours is running.** pi processes
  no submission at all while one of its own slash commands is awaiting, so
  during `/run`, `/build` or `/step` the keys are the only way in. That is why
  `ctrl+del` exists beside the command. If a later pi changes that, the key
  stays useful but the asymmetry in `docs/guide/display.md` stops being true.
- **Two runs at once - observed, and it behaves as written.** A `subagent` tool
  call was left working and `/run explore` typed one second into the same turn.
  Both were live in one frame: the tool's card reading `0/1 done, 1 running`,
  the widget above the prompt listing the pipeline's three scouts. That is what
  `extension/stop.ts` says it does - the newest run is the one whose dots are on
  screen - and the older run is not lost, it reports through its own card.
  `/stop <id>` reaches either; `ctrl+↑↓` walks the newest.

  Getting there took four tries, and the method is the finding: a command typed
  after the model's turn has ended never overlaps. Type it while the turn is
  still running (`||1||2` on the first step of `drive-pi.py`) and the two runs
  meet.
- **A refused turn is no longer counted.** Asking a stopped subagent returns
  without reaching the session, and `turns` stays where it was.

## 7. What the language rule left open - answered

Every subagent now answers in the language of the work it was handed
(`src/language.ts`). Three turns settle the wording, and they are what to re-run
the day the sentence is touched: an English task answers English, a French one
answers French, and French work inside English scaffolding answers French.

The three open items were run on 2026-09-19 against `ilaas/gpt-oss-120b`, a
second model beside the `ilaas/gemma-4-31b` everything else was measured on.

- **The last two sentinels survive a French turn.** A French interview asked
  three French questions and then answered `READY` alone, and a French delivery
  ended on an audit whose whole output was `APPROVED`. With `LGTM`, the router's
  agent name and the planner's JSON already measured, that is the four.
- **A definition that names a language wins.** An agent whose prompt ends
  "Always answer in English, whatever language the request is written in",
  handed a French task, answered English, twice. So the rule is overridable, by
  the file, which is where invariant 5 says what an agent does should be
  readable.
- **The pipeline behaves as `docs/guide/build.md` says it should.** On the
  French brief above, the planner, the coder, the auditor and the committer all
  answered English. That is the documented intent rather than a failure of the
  standing sentence, and it is now measured instead of assumed. It leaves
  invariant 12 resting on the model's judgement, though: nothing would stop a
  committer writing a French commit message on French work, and invariant 12
  says commit messages are English.

One new thing came out of it, and it is closed. **The card's header stayed
English while its question was French**: `[Cache type]` over "Quel type de
stockage de cache devez-vous utiliser ?", in both runs. A header is a value a
model writes and a user reads, not a JSON key, so `questionPrompt` names it
alongside the questions and the options now. The keys and `READY` stay as they
are, for the reason they always did: the parser reads the one and the loop ends
on the other.

## 8. Two concepts sharing a file - done for the extension, dropped for the pair

`extension/build.ts` went from **792 lines to 351**, in two moves: the shared
command floor (`CommandCtx`, `BuildDeps`, the roster, the pipeline chooser, the
flag parser, `refuse`) into `extension/command.ts`, then `/interview`, the
commit stop and `/herdr` into files of their own. The first of the two fixed a
real dependency rather than a line count: `/agents` imported its command context
from the build state machine. Nothing in `extension/` is over 351 lines now.

**The pair split is not worth doing**, which the file above assumed it was.
`src/workflows/pair.ts` is 350 lines of which the prompts are 50, and its
sibling `src/workflows/audit.ts` keeps `auditPrompt` in the same file as
`auditOnce` - splitting the pair would make the two inconsistent to save fifty
lines. The rest of `pair.ts` is one function.

If line count is the worry, the four files above it are the ones to look at:
`src/workflows/pipeline-run.ts` (444), `src/reporters/tui.ts` (437),
`src/subagent.ts` (427) and `src/workflows/deliver.ts` (384). None of them has
been read with a split in mind.

## 9. What fifty sessions cost, and what they already share - answered

The probe ran on 2026-09-19 against **pi 0.80.10** and node 26.8.2, with the
live half on `ilaas/gemma-4`. It was written to find out whether combo could
host a swarm, and two of its three answers turned out to be about this
repository rather than about that question. All three are properties of pi, and
pi moves, so the probe is worth re-running rather than reading.

**Session count is not a wall.** Fifty sessions, spawned all at once through
`spawn` with no model pattern:

| N | spawn, all at once | median | rss | per session |
| --- | --- | --- | --- | --- |
| 1 | 4ms | 4ms | 0.6MB | 624kB |
| 8 | 10ms | 9ms | 0.7MB | 94kB |
| 24 | 23ms | 21ms | 8.0MB | 343kB |
| 50 | 47ms | 43ms | 22.8MB | 467kB |

Nothing threw, closing fifty took under a millisecond, and `buildRegistry()`
costs 5ms once rather than per spawn. This is the floor: no turn had run, so no
session held a transcript, and a session's memory is mostly its transcript.

**A shared working directory is a channel, and it opens by default.** Four
subagents, one live turn each, run concurrently, told only to write a file, list
their working directory and say what they see. In four directories, nothing
crossed: each wrote its own file in its own directory, none wrote elsewhere,
nothing stray appeared and `process.cwd()` was untouched. In **one** directory,
every one of the four read all three other members' secrets, in the same turn,
without being asked to look.

`WorkflowOptions.cwd` is one string, so that second arm is what every combinator
does today whenever more than one subagent writes. `scratchWorktree` per writer
is the mitigation and the control arm shows it closes the channel. It does not
bound a subagent that goes looking: `..`, `/tmp` and everything else `read`
reaches are outside any worktree.

**A custom tool whose name collides with a built-in replaces it, silently.**
Offered a tool named `read`, the session configures one `read` and its
description is ours. No warning anywhere. Nothing in combo does this today, and
nothing should start: a tool combo defines takes a name pi does not use.

Beside that, one member can hold several tools combo defines, and pi's allowlist
still gates each one separately: declaring `board` and `subagent` gives both,
declaring `board` alone gives `board` and not `subagent`, declaring neither
gives neither. That extends section 5's table to the plural.

Two pieces of process-wide state in pi are worth knowing about, neither of them
a message channel on its own. `core/tools/file-mutation-queue.js` keeps a `Map`
of mutation queues keyed by each file's realpath, shared by every session in the
process, so two subagents editing one file are serialised through one structure
rather than isolated from each other, and a worktree per writer gives each a
different key. `core/resolve-config-value.js` holds a `commandResultCache` its
own comment describes as persisting for the process lifetime, used by auth
storage and the model registry, so the first session's shell command result is
served to every later one.

## 10. A swarm, and what running one said

Several members on one job, with nothing above them dividing it: `src/board.ts`
(append-only, `from` stamped rather than declared), `src/claims.ts` (one owner
per thing), `src/board-tool.ts` (the `board` an agent names in its `tools:`),
`src/workflows/swarm.ts`, `agents/member.md` and `examples/15-swarm.ts`.
`docs/guide/swarm.md` is the page, and `docs/decisions.md` holds why each piece
has the shape it has.

Running it settled four things, none of which an offline test could reach:

- **Everyone reads before anyone has posted.** Three members were each handed
  nothing, and all three then claimed the same file. That is a property of the
  medium rather than of the models, and it is why a claim is granted instead of
  announced.
- **A bound on holdings belongs in the mechanism.** "Take one thing at a time,
  and release it before you take another", written into a member's own
  definition, changed nothing at all: four held at once, exactly as with no
  rule. `maxPerMember` holds it to one and costs 29% in wall time and 64% in
  input tokens, so it is a knob rather than a default.
- **A claim is not a permission boundary either.** In one run the member that
  had been refused all seven keys described all seven files anyway. Claims say
  who is doing what; the toolset and a worktree say what can be done at all.
- **On tractable work a board earns nothing.** Three arms on one job, and the
  cheapest was the one with nothing arbitrating. Run to run, one arm varies more
  than the arms differ from each other.

`budget.ts` was dropped rather than deferred: nothing has asked for a budget,
and a knob nobody uses is maintenance without a user.

`/swarm` shipped once a run from the window asked for it: several copies of one
agent on one goal, drawn as a step of the chain so `/quote` and `/step --from`
reach it. It carries its own finish line - with `--claim` naming what there is,
the run stops when each thing has been reported on, which took the same job from
3 rounds and 9 turns to 1 and 3.

`--until agree` is the same finish line for a job that does not split: the goal
gains a sentence asking for `VOTE: <answer>` on a line of its own, and the run
stops when every member's latest vote says the same. Same numbers, one question
instead of three files. What it exposed is worth more than the flag - three
copies of one model agree on the first turn, having argued nothing, so a swarm
asked to debate has to be handed its disagreement. `--claim` is the only thing
here that hands one out, by leasing the opening positions one owner at a time.

Three things are left, and the case for each is weaker than it looks:

- **A released key looks free again**, so under `maxPerMember: 1` a file
  somebody has finished is taken and described a second time. Claims have no
  notion of done. The run that needs one is the moment to add it, and no run
  has yet.
- **The report generated from the log** - who talked to whom, what was held,
  and at which round a member first names a target another member raised. Every
  measurement in it but the last has been done by hand three times; the last
  needs members that talk to each other, and they stopped as soon as something
  arbitrated.
- **A job that cannot be finished alone**, which is the only one worth doing
  next. The investigation these mechanisms are modelled on found coordination
  coming out of the tasks with no legitimate solution, about 93% of the traffic
  on its board. Every run here has been on work one member could finish, which
  is the arm that shows nothing whatever the machinery does.

The **TUI says nothing about a board**: it draws subagents, and the traffic goes
to the console reporter and to `record.ts`. Whether a widget should carry a post
at all is undecided.

**A swarm in herdr opened nothing, and had never opened anything.** Reported
from the window, on `/herdr on` followed by `/swarm --members 3`. The cause was
not in the swarm: `agent.start` took an `argv` and opened a pane under herdr
0.7.3, and under 0.9.0 it takes a `kind` and a `pane_id` and starts a recognised
agent in a pane that already exists, so every request combo had ever sent was
refused. A reporter must never throw, so the refusal was swallowed and each call
after it was skipped by design - no pane, no error, no clue, for every command
and not only this one. Opening one is now `pane.split` for the pane,
`pane.rename` for the name on it, `pane.send_input` for the `tail`, and
`node scripts/check-herdr.ts` holds all six of our calls to
`herdr api schema --json`. Measured after: four panes for three members and a
board, streaming, and none left behind.

It lasted two releases because `/herdr on` asked the wrong question: whether we
are inside herdr, never whether herdr would take our request. It asks the second
one now, with a `pane.split` aimed at a pane no herdr can have - `pane_not_found`
means yes, anything else is quoted back at the user - and says
`on, but herdr refused pane.split: … - nothing will open`. Checked against the
running server on all three answers, including the shape that shipped, with no
pane opened by any of them.

## 11. A pane that is a pi session - done, and not yet seen inside herdr

A herdr split used to show a text file and take no keyboard. It now runs a
client of the session, drawn with pi's own components: the mirror
(`src/mirror.ts`) puts every live subagent on one unix socket, replays the
transcript on attach, forwards pi's events and takes `steer` and `abort` back;
the pane (`pane/main.ts`) draws that with pi's chat components and an editor
under them; the herdr reporter types the pane's command into the split instead
of `tail`. Run by hand in a pty against `ilaas/gemma-4-31b`, the pane drew the
turn as pi draws it, and a line typed one second in came back as
`Result.output`.

What the probe settled before it, on pi 0.80.10 and 0.85.1 alike: a steer
mid-turn lands after the tool call in flight and stays in the transcript; a
steer or follow-up queued while idle is delivered into the **next** `ask` and
changes what the workflow reads back. So the mirror refuses a word between
tasks and queues nothing, and `followUp` is nowhere in the library.

What no sandbox here could do is open it inside herdr. Two things to look at
in a real one, in this order: that a split opens on the pane rather than on a
usage error, which is `process.execPath` being node and the quoting holding;
and that `esc` in a split stops the subagent and nothing else, since herdr
may read some keys before the pane does.

Two things a frame showed and nobody has judged in a real terminal yet: the
thinking block is drawn as text, not in pi's muted style, and the pane has no
header, since the split's own label already names the subagent.

## 12. The flow format - being built

A flow is a task graph in YAML + Markdown (branches, parallel forks, bounded
loops, human nodes, sub-flows) that replaces the linear pipeline. It is built in
`src/flow/` beside `src/pipeline/`, one PR per layer, each tested offline and
wired to no command, in this order: conditions; the file and its validation;
the runner and a dry run; `ask`, `check` and `commit` with their ports;
sub-flows; persistence and resume; the renderings; the live view; the shipped
flows. Then one breaking PR switches `/build` and `/pipelines` to `/run` and
`/flows`. [Flows: a closed language](docs/decisions.md#flows-a-closed-language)
says why the old "no YAML DSL" line moved.

Done so far: conditions (`src/flow/condition/`), schemas (`src/flow/schema.ts`), the file with `checkFlow` for `agent`, `choice`, `parallel`, `map` and `loop` nodes, and `loadFlowCatalogue`, which reads flows and agents from disk, keeps broken agent files with their cause, and checks each agent's skills. The runner (`src/flow/run/`) walks every kind of node: the composed turn, typed outputs through `submit`, `agent-from`, memory scopes, `retry:`, `timeout:`, failures and stops, visit events; `parallel` and `map` with `fail-fast` and `too-many`; `loop` with `until`, `give-up`, `carry` and `previous`; ledgers and `verdict:` nodes through the review record. `dryRunFlow` runs it on scripted sessions, keyed by address or exact visit path. `checkRun` is the run stage: `runFlow` takes the `CheckedRun` it returns, holding the tree, the ports and each check script's content. The `check` node runs a project script through the `check` port (`bashCheck` in `src/verify.ts`, beside the pipeline's `Verify`), and a dry run answers it from the script. The `git` port (`gitPort` in `src/git/port.ts`) is how the runner reaches git: the `commit` node commits on the run's own branch, `diff` reads a node's tree with untracked files and without touching the index, and `copies: true` runs each branch in a copy made from a snapshot of the tree, landing the patches in branch order with `landed` and `refused` in each branch's entry. `checkRun` is async, since it asks the port whether `cwd` is a repository. The `ask` node puts a question through the `ask` port (`AskUser`, grown an optional `Asking` argument): a choice card, a yes or no or a free text, its reads shown above it, one card at a time across branches, `default:`, `enough:` and `timeout:` for nobody answering, and `unattended-ask` at the run stage. Literal options type `answer` as an enum, and an `ask-from` answer compares to no literal (`condition-free-string`). The extension's card does not take `Asking` yet. The `flow` node calls another flow of the catalogue, nearest file first: the callee is checked whole with its caller (`broken-flow`, `call-cycle` with its path, `flow-input-mismatch`), only `input` goes in and the last root node's output comes back, its memory scopes are its own, and it runs through the run's ports. The copies, commit and run-stage rules read through calls, at the call path. `model:` and `timeout:` are read from the callee outward, and a dry run scripts a call whole or walks into it. `runFlow` takes an optional `runDir`: before the first node it receives the snapshot (`snapshot.json`, with every flow file reached, each named agent as parsed, each check script, the input and the settings, and each agent's skills copied under `agents/<agent>/skills/`), and the runner appends each fact to `journal.jsonl` through a journal port: an ended visit, a `carry`, a `map`'s list, an obligation raised or closed, a copy opened or landed, the run's branch, the run's end. A dry run hands the same entries back as an array. `checkFlow` exposes what it read as the checked flow's `sources`; `readSnapshot` gives back a catalogue that checks the same, and `readJournal` ignores a torn last line. Next: `resumePoint`, `resumeFlow` and the lock.

## How to verify anything here

```bash
npm test                       # offline, no network
npm run typecheck
node scripts/check-herdr.ts    # our herdr calls, against herdr's own schema

node examples/03-fan-out.ts --model ilaas/qwen-3.6-35b-instruct
node examples/06-export.ts --model ilaas/qwen-3.6-35b-instruct
node examples/07-reduce.ts --model ilaas/qwen-3.6-35b-instruct
node examples/09-orchestrate.ts --model ilaas/qwen-3.6-35b-instruct
node examples/10-interview.ts "add a cache"          # the interview, in readline
node examples/11-build.ts <throwaway-repo> "…"       # the pipeline, minus the commit
node examples/15-swarm.ts --model ilaas/gemma-4-31b            # three members, one board
node examples/15-swarm.ts --model ilaas/gemma-4-31b --control  # the arm it has to beat
pi -e extension                # interactive, to actually see the TUI

python3 scripts/drive-pi.py \
  "/run explore what does the ledger record||3||9" \
  "key:ctrl+down||2||3" "key:ctrl+delete||3||8" "key:escape||5||30"
```

`drive-pi.py` types into a real pi and prints the frames. A `key:<name>` step
presses a key instead of typing a line, which is the only way to exercise what
interrupts a run; a run repaints four times a second, so those steps end on
their cap rather than on silence.

```bash
python3 scripts/drive-pi.py --log run.log "/interview add a cache||10||180"
python3 scripts/frame.py run.log run.png    # the same frame, with its colours
```

`frame.py` replays the raw log through a terminal emulator and draws it, which
is the only way to see spacing and colour. It needs `pyte` and `pillow`.

Notes that save time:

- **`ilaas/gpt-oss-120b` is the one to reach for when a run has to work.**
  Measured on 2026-09-19: it planned, paired, checked, audited and wrote a commit
  message end to end, twice, and the tests it wrote pass on a clean checkout.
  `mistral-small-4-119b` is larger and unusable here, because it emits
  `[TOOL_CALLS]…` as plain text in the message that ends a turn, so pi runs
  nothing and the subtask finishes holding that string as its answer.
- **`ilaas/*` now reports tokens, and still no cost.** Measured on 2026-08-01
  against `ilaas/qwen-3.6-35b-instruct` and `ilaas/gemma-4`: `↑28k ↓8.3k` on a
  single turn, `$0.0000` throughout. It used to report neither, so a provider's
  counters are worth re-checking rather than trusted from this list.
  `opencode-go/*` has not been re-measured since. `local/*` reports both, and is
  much slower.
- **A weak model can burn a turn without ending it.** In that same run a coder
  made **111 tool calls in one turn** before `timeoutMs` cut it at 120s, and pi
  counted the prompt on every request: `↑2.6M` for a 14k context. That is not an
  aggregation bug, it is what a runaway turn costs - and the reason `timeoutMs`
  has no default but belongs on anything unattended. Budget 300s per turn for
  these models; 120s fails roughly half the cells.
- **A known flag written after the name is prose, silently.** `parseLeadingFlags`
  reads flags only while they lead, on purpose: an unknown `--flag` in free
  prose may simply be the text, and `/build fix the --pipeline flag` is a real
  request. The cost was measured on 2026-09-19:
  `/run explore where is the wall time measured --model ilaas/mistral-small-4-119b`
  ran three scouts on gemma and one of them spent its turn grepping the
  repository for `ilaas/mistral-small-4-119b`. Refusing a *known* name found in
  the text would catch it and would break the `--pipeline` case above, so this
  is a decision rather than a fix: warn and carry on, refuse, or leave it.
- **`ilaas` serves more models than `~/.pi/agent/models.json` declares.**
  `GET /v1/models` on 2026-09-19 listed seven, among them `gpt-oss-120b`,
  `mistral-small-4-119b`, `mistral-medium-latest` and `llama-3.1-8b`; the file
  named two. A model absent from the file cannot be reached by `--model`, so
  check the endpoint before concluding a provider has nothing stronger.
- **A run with no `--model` runs on the operator's settings, silently.** No
  shipped agent declares a `model:` (deliberately - see invariant 5), so
  `/run explore` put its four subagents on `ilaas/gemma-4-31b`, read from
  `~/.pi/agent/settings.json` and named nowhere in this repository. Pass
  `--model` for anything whose numbers you intend to compare.
- **A subagent's working directory is not a private one.** Two subagents given
  the same `cwd` read each other's files in one turn, measured on 2026-09-19.
  Anything that runs several writers wants a worktree each, not a shared tree.
- To test herdr from a plain shell, export the three variables herdr injects:
  `HERDR_ENV=1`, `HERDR_SOCKET_PATH=~/.config/herdr/herdr.sock`,
  `HERDR_PANE_ID=<a real pane>`. `herdr pane list` shows the splits appear and
  close.
- **Driving the tool from a weak model does not work as a smoke test.** Asked
  to call `subagent` once, `ilaas/qwen-3.6-35b-instruct` announced the call and
  then looped without ever emitting it. To exercise the real wiring, call
  `executeSubagent` from a script instead: same code path, no driver model.
- **`examples/11-build.ts` writes code**, in the directory you give it. It
  refuses to run on this repository and has no default - point it at a git
  repository you do not care about.
- **A weak planner writes dependent subtasks whatever the prompt says.** The
  observed plan had a step starting "review the code identified by the scout",
  in a fan-out where nobody sees anyone else's result. `orchestrate` cannot
  check that; sequential work belongs in `chain`.
- **A green suite proves less than it looks here.** Every test injects a fake
  `SessionPort`, so nothing exercises pi's real module. Anything that only runs
  inside a real pi has to be exercised inside a real pi.
- **An extension shortcut swallows its key, whatever the handler does.** pi
  matches extension shortcuts *before* its own keybindings and consumes the key
  as soon as one matches, so registering `escape` would have broken interrupt,
  autocomplete cancellation and clearing the editor for the whole session. Keys
  that must coexist with pi's own go through `ctx.ui.onTerminalInput`, which can
  read a key and let it through.
- **The site build needs an environment of its own.** `make -C docs html`
  expects `python` on the path and sphinx installed, which a bare machine has
  neither of. `uv venv <dir> && uv pip install --python <dir>/bin/python -r
  docs/requirements.txt`, then `<dir>/bin/python -m sphinx -b html docs <out> -W`,
  is the recipe that works from nothing. `npm test` catches the structural half
  anyway - a page missing from a `toctree`, a relative link resolving to nothing
  - so a change to `docs/` is never unguarded, but only the real build answers
  whether it renders.
- **`pi -e extension` from this repository does not exercise the installed pi.**
  Measured on 2026-09-17 with the CLI at 0.85.1: an extension loaded by a path
  inside this checkout resolved `@earendil-works/pi-coding-agent` to
  `node_modules`, that is 0.80.10, and reported so itself. Node resolves from the
  file's real path, and the documented install is a symlink back into the
  checkout, so the symlink does not change it either. Running the extension in a
  real pi is still the only way to catch a shape change, but it catches the shape
  of whatever `npm install` put in `node_modules`. To exercise another pi, build
  a scratch directory whose own `node_modules/@earendil-works/pi-coding-agent`
  points at the pi you mean, copy the case into it, and import nothing from this
  repository. This narrows the `AGENTS.md` note that says the pi that matters is
  the one the extension runs inside; that wording deserves revisiting in
  whichever PR next touches `buildRegistry`.
