# Development

```bash
npm test          # node --test, offline, no network calls
npm run typecheck # tsc --noEmit
npm run docs      # regenerate docs/reference/api/ from the TSDoc
```

Node 23.6 or later runs TypeScript natively. There is no build step, and
`erasableSyntaxOnly` is on: no enums, no namespaces, no parameter properties.
Node erases types, it does not compile them.

## Layout

```
src/                 the library - the only thing that matters
  session.ts         the whole pi API, and nowhere else
  subagent.ts        spawn() -> Subagent { ask, usage, close }
  workflows/         the combinators
  reporters/         herdr, pi TUI, console, silent
extension/           the pi extension: tool, commands, renderers
agents/              example agent definitions (symlinked into .pi/agents/)
examples/            one runnable script per shape
scripts/             the documentation generator and its coverage checker
test/                node --test, with fakes for pi
docs/                this documentation: guide/ task by task, reference/ to
                     look something up
```

**One file, one concept.** Past roughly 200 lines, it is mixing two.

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
resolves, every page is listed in `docs.json`, and every symbol a code fence
imports from `combo` really exists. A renamed export therefore breaks the
documentation build, not a reader's afternoon.

[Design decisions](decisions.md) records **decisions**, not the state of the
code. When a decision is reversed, the reversal is written there with its reason.
`AGENTS.md` keeps only the short version - the invariants an agent must not
violate - and the rest of this directory explains how to use what those decisions
produced.

## Conventions

- TypeScript, ESM, tabs, double quotes - like pi's own code.
- Errors: a typed `Result` on normal paths. `throw` only for programming errors
  (invalid configuration, unknown agent, already-closed subagent).
- **Dependencies kept to a strict minimum**: the pi SDK, and nothing else without
  discussion. Never import pi's transitive packages directly; derive what you
  need from the public surface.
- Before adding a layer of configuration, ask whether a function call would do.
