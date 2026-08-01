# What is left

Written to be picked up cold. `AGENTS.md` holds the decisions and the pi API
notes; this file holds only what has not been done yet, and the traps already
paid for.

State: offline tests green, clean typecheck, working tree clean.

Shipped: the foundation (`Agent`, `Subagent`, `Result`, `Usage`, event bus),
nine combinators (`chain`, `fanOut`, `loop`, `reduce`, `route`, `orchestrate`,
`interview`, `pair`, `deliver`), four reporters (herdr, TUI, console, silent),
the session export, **pipelines** (a workflow written in Markdown, discovered in
`~/.pi/agent/pipelines` and `.pi/pipelines`, run by `/build`), a generated and
test-enforced `docs/`, and the pi extension: the `subagent` tool plus
`/interview`, `/herdr` and `/build` (with `/build resume` and
`/build --pipeline <name>`).

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
/herdr on                                  # a split per subagent, to watch it work
/build add a slugify helper with tests      # in a throwaway repository
/build --pipeline explore how usage is measured
/build resume                               # after interrupting one
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

## 3. Distributing it as a package

Decided and done for the loading side: the extension ships `agents/` and
`pipelines/` and asks for them at the lowest priority, so `pi -e
../subagent/extension` in any directory now finds `scout` and `build` without
anything being copied. `AGENTS.md` records why that reverses the rule it
replaced.

What is *not* done is the packaging itself. pi's `docs/packages.md` lists
extensions, skills, prompt templates and themes - agents are not on that list, so
`pi install` will not place anything in `~/.pi/agent/agents/`. It does not have
to any more, since the extension carries its own; but before publishing to npm,
check that `agents/` and `pipelines/` actually land in the tarball. There is no
`files` field in `package.json` today, so they do - and adding one later without
listing them would break `/build` silently. `test/pipeline-load.test.ts` asserts
that a pipeline named `build` is shipped, which is the tripwire for exactly that.

## How to verify anything here

```bash
npm test                       # offline, no network
npm run typecheck

node examples/03-fan-out.ts --model ilaas/qwen-3.6-35b-instruct
node examples/06-export.ts --model ilaas/qwen-3.6-35b-instruct
node examples/07-reduce.ts --model ilaas/qwen-3.6-35b-instruct
node examples/09-orchestrate.ts --model ilaas/qwen-3.6-35b-instruct
node examples/10-interview.ts "add a cache"          # the interview, in readline
node examples/11-build.ts <throwaway-repo> "…"       # the pipeline, minus the commit
pi -e extension                # interactive, to actually see the TUI
```

Notes that save time:

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
- **A run with no `--model` runs on the operator's settings, silently.** No
  shipped agent declares a `model:` (deliberately - see invariant 5), so
  `/run explore` put its four subagents on `ilaas/gemma-4-31b`, read from
  `~/.pi/agent/settings.json` and named nowhere in this repository. Pass
  `--model` for anything whose numbers you intend to compare.
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
