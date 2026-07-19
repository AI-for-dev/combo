# What is left

Written to be picked up cold. `AGENTS.md` holds the decisions and the pi API
notes; this file holds only what has not been done yet, and the traps already
paid for.

State: 297 offline tests, clean typecheck, working tree clean.

Shipped: the foundation (`Agent`, `Subagent`, `Result`, `Usage`, event bus),
the six combinators (`chain`, `fanOut`, `loop`, `reduce`, `route`,
`orchestrate`), four reporters (herdr, TUI, console, silent), the pi extension
with an injectable tool body, and the session export.

All four founding requirements of `AGENTS.md` are now met; what follows is
breadth and polish, not a missing promise.

## 1. Judge the interactive rendering

Nobody has looked at the TUI in interactive mode. The components build and
render correctly in tests, but spacing, colours and density were never seen.

Specifically open: the widget above the prompt uses **two lines per subagent**,
so a fan-out of three takes six lines. If that is too much, condense the dimmed
line or keep it only for active subagents.

## How to verify anything here

```bash
npm test                       # 297 offline tests, no network
npm run typecheck

PI_SUBAGENT_MODEL=ilaas/qwen-3.6-35b-instruct node examples/03-fan-out.ts
PI_SUBAGENT_MODEL=ilaas/qwen-3.6-35b-instruct node examples/06-export.ts
PI_SUBAGENT_MODEL=ilaas/qwen-3.6-35b-instruct node examples/07-reduce.ts
PI_SUBAGENT_MODEL=ilaas/qwen-3.6-35b-instruct node examples/09-orchestrate.ts
pi -e extension                # interactive, to actually see the TUI
```

Notes that save time:

- `ilaas/*` and `opencode-go/*` report **no tokens** - usage lines read `↑0 ↓0`.
  `local/qwen/qwen3-coder-next` does report them, but is much slower.
- To test herdr from a plain shell, export the three variables herdr injects:
  `HERDR_ENV=1`, `HERDR_SOCKET_PATH=~/.config/herdr/herdr.sock`,
  `HERDR_PANE_ID=<a real pane>`. `herdr pane list` shows the splits appear and
  close.
- **Driving the tool from a weak model does not work as a smoke test.** Asked
  to call `subagent` once, `ilaas/qwen-3.6-35b-instruct` announced the call and
  then looped without ever emitting it. To exercise the real wiring, call
  `executeSubagent` from a script instead: same code path, no driver model.
- **A weak planner writes dependent subtasks whatever the prompt says.** The
  observed plan had a step starting "review the code identified by the scout",
  in a fan-out where nobody sees anyone else's result. `orchestrate` cannot
  check that; sequential work belongs in `chain`.
- **A green suite proves less than it looks here.** Every test injects a fake
  `SessionPort`, so nothing exercises pi's real module. Anything that only runs
  inside a real pi has to be exercised inside a real pi.
