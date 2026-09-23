# Development

```bash
npm test          # node --test, offline, no network calls
npm run typecheck # tsc --noEmit
npm run docs      # regenerate docs/reference/api/ from the TSDoc
make -C docs html # build the site; needs docs/requirements.txt, warnings are errors
```

Node 23.6 or later runs TypeScript natively. There is no build step, and
`erasableSyntaxOnly` is on: no enums, no namespaces, no parameter properties.
Node erases types, it does not compile them.

## Layout

```
src/                 the library - the only thing that matters
  session.ts         the whole pi API, and nowhere else
  subagent.ts        spawn() -> Subagent { ask, usage, close }
  board/             the swarm's shared board and its arbiter
  git/               the working copy: git, worktrees, landing patches
  measure/           what a run leaves behind: exports, usage.json, experiments
  flow/              a task graph written down, built beside pipeline/: the
                     file, its validation, its schemas and its conditions
  pipeline/          a workflow written down: read, found, run
  review/            the review record: a verdict and a ledger, read together
  workflows/         the combinators
    deliver/         the delivery, its git policy and its saved state
  reporters/         herdr, pi TUI, console, silent
extension/           the pi extension: the tool and the floor at its root,
  commands/ ui/      one file per slash command; what paints the terminal
agents/              example agent definitions (symlinked into .pi/agents/)
examples/            one runnable script per shape
scripts/             the documentation generator and its coverage checker
test/                node --test, with fakes for pi
docs/                this documentation: guide/ task by task, reference/ to look
                     something up, and conf.py + _static/ to build it as a site
```

**One file, one concept.** Past roughly 200 lines, it is mixing two.

**One directory, one module.** When several files' headers name each other,
they are one module, and they sit in a directory whose `index.ts` is the only
file anything outside it imports. Tests are the exception: they reach past
every door, by design. The generated reference follows the file that declares a
symbol, so a module's pages land under its directory.

**The pi API lives in one file.** `src/session.ts` is the only place that imports
from the pi package. Everything else talks to `SessionPort`, a minimal subset of
a session, which is what lets tests inject a fake with no network, no disk and no
`~/.pi`.

## Tests

No network calls, ever. Workflows are tested with an injected `spawn`, which is
why `spawn` is a parameter rather than a hard import inside the combinators.

The fake session reproduces the pi behaviours that are easy to get wrong, because
otherwise the tests pass on broken code:

- `getSessionStats()` is **cumulative**. A fake returning per-turn stats would
  hide the very bug the delta arithmetic exists to prevent.
- `messages` **grows** with every turn.
- `abort()` genuinely **cuts the in-flight turn short**. A fake that slept
  through its own abort made the timeout tests pass while the turn still ran for
  its full five seconds. Assert on elapsed time, not just on the error message:
  a correct label on a still-hanging turn is not a guard.

Every new workflow primitive arrives with a composition test, a failure test, a
cancellation test, and a **lifetime test**.

The fake `spawn` emits the same events as the real one. Without that, a reporter
wired above a combinator sees an empty stream in tests and a full one in
production, and every display assertion passes on nothing.

What a fake still cannot prove is that pi's own module has not changed shape. A
real pi run stays the only check for that - see [Extension](guide/extension.md).

### Driving a real pi

A slash command's output exists only in the TUI: `ctx.ui.notify` writes to pi's
own surface, so `pi -p "/agents"` exits 0 having printed nothing, and
`--mode json` shows one session event. `scripts/drive-pi.py` opens a pty, so pi
believes it is talking to a terminal, types the commands and prints the frames:

```bash
python3 scripts/drive-pi.py --model <provider/model> \
    "/step scout where the wall time is measured||25||300" "/chain" "/quote"
```

Each argument is a command line, optionally followed by `||idle||cap` in
seconds - a step that spawns subagents needs a longer silence than a listing
before it counts as finished.

**It scrapes a terminal, and it is not a test.** It never runs in `npm test`,
because where a step ends is decided by a stretch of silence and therefore by
model latency. Run it by hand before claiming a change to the extension works.
It is how `/share` was found to collide with one of pi's built-in slash
commands - the fake `pi` the tests hand the extension has no built-ins to
collide with, so nothing offline could have said so.

Its `--model` is pi's own model, and not the subagents': a command spawns them
on the `--model` **it** was given, and on pi's settings when it was given none.
A frame showing one model in the status bar and another under every subagent is
not a bug, it is those two knobs being set apart.

### Asking herdr what it accepts

herdr moves the same way, and it moved once under us: `agent.start` used to
take an `argv` and open a pane, protocol 22 gave it a `kind` and a `pane_id`,
and every request combo sent was refused. A reporter never throws, so nothing
said so, and the whole suite stayed green over a `/herdr on` that opened
nothing.

```bash
node scripts/check-herdr.ts
```

It runs the reporter through a subagent's whole life against a recording
transport, then holds every request it made to `herdr api schema --json`. It
needs the `herdr` binary rather than a herdr session, so it runs from anywhere,
and because it validates what the code sends rather than a copy of it, it cannot
drift from the code the way example payloads would.

### Looking at a frame

Printed frames have their escape sequences stripped, which answers what pi said
and nothing about how it looked. `--log` keeps the raw bytes, and
`scripts/frame.py` replays them into a screen and draws it:

```bash
python3 scripts/drive-pi.py --log run.log "/run explore how usage is measured||6||150"
python3 scripts/frame.py run.log run.png
```

It needs `pyte` and `pillow`, asked for at the prompt rather than in a
requirements file: like `drive-pi.py` it is a pre-flight run by hand, and
`npm test` must not come to depend on a python environment.

Spacing, colour and density are the half of the display no assertion covers. The
first three pictures it drew found an option description cut mid-word at the
right edge, a fan-out reading `scout#2, scout#1, scout#3`, and `esc` claiming
two different things on screen at once.

## Documentation

Documentation is part of the deliverable, not a follow-up task.

- **TSDoc on every public export**, stating the invariant it upholds whenever
  that is not obvious ("the delta, not the cumulative total", "whoever opens,
  closes"). A comment that restates the signature is noise.
- **Comments explain why, never what.** If a line needs a comment to say what it
  does, rewrite the line.
- **One executable example per combinator.**
- **English everywhere**: documentation, comments, public API, agent system
  prompts, and commit messages.

### How it stays honest

`docs/reference/api/` is **generated** from the TSDoc of everything `src/index.ts`
re-exports, by `scripts/gen-docs.ts`, using the TypeScript compiler API - already
a devDependency, so nothing new was added for it.

`test/docs.test.ts` then enforces two things that no typechecker can:

1. **Coverage.** Every exported top-level declaration in `src/` and `extension/`
   carries a TSDoc, every file carries a header, and every member of a public
   type carries one too. A missing one fails the suite by name.
2. **Freshness.** The checked-in pages are compared against what the generator
   produces today. Editing a signature without regenerating is a red test, and
   the fix is `npm run docs`.

Members are required on the public surface only. An options type a caller has to
fill in is unusable without a word per field; an internal record shape is read
next to its one use, and demanding prose there produces exactly the comment that
restates the signature.

The hand-written pages under `docs/` are checked more modestly: every link
resolves, every page is reached by a `toctree`, and every symbol a code fence
imports from `combo` really exists. A renamed export therefore breaks the
documentation build, not a reader's afternoon.

The toctrees are read straight out of the Markdown, because they are the site's
navigation: Sphinx builds the sidebar from them and warns about any page no tree
names. Asking the same question offline, in `npm test`, means a page added
without a place to reach it fails in seconds rather than at the next site build.

That site is Sphinx over these same files - `make -C docs html`, warnings as
errors, and `.github/workflows/docs.yml` running the same command on every pull
request before `main` publishes it to GitHub Pages. `docs/README.md` has the commands, the layout, and what may be written in
Sphinx syntax rather than plain Markdown: these pages are read in the repository
and in the published tarball as well as on the site, so the answer is very
little. It documents the build rather than the library, which is why neither the
site nor the check above counts it as a page.

[Design decisions](decisions.md) records **decisions**, not the state of the
code. When a decision is reversed, the reversal is written there with its reason.
`AGENTS.md` keeps only the short version - the invariants an agent must not
violate - and the rest of this directory explains how to use what those decisions
produced.

## Releasing

The version sits in `package.json` and in `.release-please-manifest.json`, and
nobody edits either by hand.
[Release Please](https://github.com/googleapis/release-please) reads the
conventional commit titles landed on `main` and writes the next release: the
changelog, the two version numbers, nothing else.

The package has never been published, so the manifest starts from `0.0.0` and
Release Please treats the next one as an initial release. An initial release
takes whatever `initial-version` names, `1.0.0` when nothing does, which is why
the configuration names `0.1.0`.

Releasing takes two runs of `.github/workflows/release-please.yml`, both started
by hand from the Actions tab. The first opens the release pull request. Once
that pull request is merged, the second tags the release and writes the GitHub
release. An ordinary merge starts neither, which is the point.

Writing the release is what `.github/workflows/publish.yml` waits for. It runs
the typecheck and the suite on the tag, then stages the tarball on npm with
provenance and no token: npm recognises the workflow by the OIDC identity GitHub
gives it. A publish that failed is run again on its own, with the tag as its
input, which is why it is a workflow of its own and not a second job beside the
release.

Staged, because npm asks for proof of presence on a write and a workflow has no
second factor. The version is not installable until a person finishes it:

```bash
npm stage list                  # what the workflow left, with its id
npm stage view <id>             # what is in it
npm stage approve <id>          # this is the publication
```

`npm stage reject <id>` throws it away instead, which is the way back from a
tarball that should not have been built.

Pull requests are squashed here, so the pull request title becomes the commit
title Release Please reads. `feat:` gives a minor version, `fix:` a patch, and a
`!` or a `BREAKING CHANGE:` footer gives a major one once the package reaches
1.0. `.github/workflows/check-pr-title.yml` refuses a title outside that
vocabulary, rather than letting a change vanish from the changelog.

What goes out is this tree, with no build step: `src/`, `extension/`, `pane/`,
`agents/`, `pipelines/` and these pages, as `files` lists them. The same tarball
is a library and a pi package, `exports` answering
`import … from "@ai-for-dev/combo"` and the `pi` manifest answering
`pi install npm:@ai-for-dev/combo`. `npm pack --dry-run` says what would be sent.

`files` names directories, so whatever a build drops inside one travels with the
package: `docs/_build/` and the Sphinx configuration's `docs/__pycache__/` went
out with 0.1.0 that way, 480 files of generated site in a package of 235.
A whitelist cannot say "except whatever was generated", so both are subtracted
by name, and publishing happens on a fresh checkout in CI where neither exists.

## Conventions

- TypeScript, ESM, tabs, double quotes - like pi's own code.
- Errors: a typed `Result` on normal paths. `throw` only for programming errors
  (invalid configuration, unknown agent, already-closed subagent).
- **Dependencies kept to a strict minimum**: the pi SDK, and nothing else without
  discussion. Never import pi's transitive packages directly; derive what you
  need from the public surface.
- The three packages pi bundles - `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui` and `typebox` - are **peer dependencies** with a `*`
  range, which is what pi's packaging documentation asks for. An installed copy
  must bind to the pi it is loaded into, not to a second one of its own: that is
  the same trap as `buildRegistry` choosing by the presence of an export.
- Before adding a layer of configuration, ask whether a function call would do.
