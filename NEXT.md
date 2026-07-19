# What is left

Written to be picked up cold. `AGENTS.md` holds the decisions and the pi API
notes; this file holds only what has not been done yet, and the traps already
paid for.

State: 404 offline tests, clean typecheck, working tree clean.

Shipped: the foundation (`Agent`, `Subagent`, `Result`, `Usage`, event bus),
nine combinators (`chain`, `fanOut`, `loop`, `reduce`, `route`, `orchestrate`,
`interview`, `pair`, `deliver`), four reporters (herdr, TUI, console, silent),
the session export, and the pi extension: the `subagent` tool plus `/interview`
and `/build`.

All four founding requirements of `AGENTS.md` are met, and the end-to-end flow
(question → interview → plan → worker/reviewer pairs → check → audit → commit)
runs. What follows is judgement and polish.

## 1. Judge the interactive rendering - and `/build` end to end

Nobody has looked at the TUI in interactive mode. The components build and
render correctly in tests, but spacing, colours and density were never seen, and
**the question card has never been looked at by a human**. That is the one thing
no test here can do.

```bash
pi -e extension
/interview add a cache in front of the agent loader
/build add a slugify helper with tests      # in a throwaway repository
```

Specifically open: the widget above the prompt uses **two lines per subagent**,
so a fan-out of three takes six lines. If that is too much, condense the dimmed
line or keep it only for active subagents. And on the card: whether the two
standing entries (Other…, "that's enough") read as part of the question or as
chrome.

## 2. The pipeline is only as good as its worker

The machinery was verified on a throwaway repository against
`ilaas/qwen-3.6-35b-instruct`: the plan was made, the pair converged, the check
caught a failing test, the auditor named the fix, the fix ran, the check ran
again, and the run ended `NOT approved` rather than shipping something broken.
That last part is the machinery working.

What it also showed: a weak worker flip-flops - it "fixed" an import by
reverting the previous fix. Nothing in `deliver` can repair that, and no prompt
will. Worth trying with a strong model before concluding anything about the
shape of the pipeline.

## How to verify anything here

```bash
npm test                       # 404 offline tests, no network
npm run typecheck

PI_SUBAGENT_MODEL=ilaas/qwen-3.6-35b-instruct node examples/03-fan-out.ts
PI_SUBAGENT_MODEL=ilaas/qwen-3.6-35b-instruct node examples/06-export.ts
PI_SUBAGENT_MODEL=ilaas/qwen-3.6-35b-instruct node examples/07-reduce.ts
PI_SUBAGENT_MODEL=ilaas/qwen-3.6-35b-instruct node examples/09-orchestrate.ts
node examples/10-interview.ts "add a cache"          # the interview, in readline
node examples/11-build.ts <throwaway-repo> "…"       # the pipeline, minus the commit
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
