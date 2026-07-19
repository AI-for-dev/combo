# What is left

Written to be picked up cold. `AGENTS.md` holds the decisions and the pi API
notes; this file holds only what has not been done yet, and the traps already
paid for.

State at `22ce682`: 180 offline tests, clean typecheck, working tree clean.

Shipped: the foundation (`Agent`, `Subagent`, `Result`, `Usage`, event bus),
three combinators (`chain`, `fanOut`, `loop`), four reporters (herdr, TUI,
console, silent), and the pi extension.

## 1. Make the extension's `execute` testable — do this first

`extension/index.ts` `execute()` has **no injection seam**, so the path that
wires the reporters and calls the combinators is covered by nothing. Its
renderers are tested; that path is not.

Three bugs reached the user through it in one day, each with a green suite:

- `ModelRuntime` was `undefined` in pi 0.80.6 → `undefined.create()`
- the herdr reporter was never subscribed, so `openInHerdr` reached the `spawn`
  event with nobody listening: no split, no error, no clue
- `openInHerdr` in an agent's frontmatter was silently ignored

The shape to aim for: let `execute` take an injectable `spawn` (and a `ctx.ui`
double), the way the combinators already do, then test the wiring offline. Until
then, **every change to `execute` must be exercised by hand, inside pi, inside
herdr**. That is not a good place to stay.

## 2. Session export — the only broken promise of `AGENTS.md`

Requirement 4 is "everything is measured **and exportable**". Measurement is
done; export is not started. See the *Session export* section of `AGENTS.md` for
the full specification. Target: `runs/<timestamp>/` with `main.html`,
`main.jsonl`, a pair per subagent, and a `usage.json`.

Two traps already identified:

- **`SessionManager.inMemory()` persists nothing.** A subagent is only
  exportable when spawned with an explicit `sessionDir` - the plumbing exists
  (`SpawnOptions.sessionDir`, `WorkflowOptions.sessionDir`) but nothing uses it
  yet. In-memory stays the default: subagents must not pollute `~/.pi`.
- `exportToHtml()` / `exportToJsonl()` are `AgentSession` methods and must be
  called **before `dispose()`**. `SessionPort` does not expose them yet.

## 3. The three remaining combinators

| Workflow | Shape | Semantics |
|---|---|---|
| `reduce` | N→1 | one agent synthesises a fan-out's results |
| `route` | 1→1 | a classifier agent picks the destination agent |
| `orchestrate` | 1→? | an agent *decides* the split, then delegates |

`orchestrate` is the interesting one and the only one with a real open
question: **how to parse what the agent decided**. Structured output, a tool
call, or a parsed convention - that decision has not been taken.

Each arrives with the four tests `AGENTS.md` requires: composition, failure,
cancellation, and lifetime (the same scenario in `"task"` and `"workflow"` must
not produce the same number of spawns).

## 4. Judge the interactive rendering

Nobody has looked at the TUI in interactive mode. The components build and
render correctly in tests, but spacing, colours and density were never seen.

Specifically open: the widget above the prompt uses **two lines per subagent**,
so a fan-out of three takes six lines. If that is too much, condense the dimmed
line or keep it only for active subagents.

## How to verify anything here

```bash
npm test                       # 180 offline tests, no network
npm run typecheck

PI_SUBAGENT_MODEL=ilaas/qwen-3.6-35b-instruct node examples/03-fan-out.ts
pi -e extension                # interactive, to actually see the TUI
```

Notes that save time:

- `ilaas/*` and `opencode-go/*` report **no tokens** - usage lines read `↑0 ↓0`.
  `local/qwen/qwen3-coder-next` does report them, but is much slower.
- To test herdr from a plain shell, export the three variables herdr injects:
  `HERDR_ENV=1`, `HERDR_SOCKET_PATH=~/.config/herdr/herdr.sock`,
  `HERDR_PANE_ID=<a real pane>`. `herdr pane list` shows the splits appear and
  close.
- **A green suite proves less than it looks here.** Every test injects a fake
  `SessionPort`, so nothing exercises pi's real module. Anything that only runs
  inside a real pi has to be exercised inside a real pi.
