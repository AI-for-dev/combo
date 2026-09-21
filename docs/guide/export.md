# Export

Ask for a directory, and every subagent writes its own transcript into it as it
closes. Two formats, both produced by pi itself: a readable HTML page and a
replayable JSONL. We render neither.

```typescript
import { createRunDir, fanOut, measuredRun } from "@ai-for-dev/combo";

const dir = createRunDir();               // runs/<timestamp>/
const run = measuredRun({ dir });         // the clock starts here

await fanOut({ agent: scout, tasks, exportDir: dir, onEvent: run.onEvent });
run.finish();                             // usage.json, with the time measured
```

`measuredRun` is the one assembly of a picture, a clock and the report: the pi
extension's live view is one with a terminal on top, an experiment's cell is
one with a recorder beside (`record: true` keeps `events.jsonl`), and a script
that wants `usage.json` is one with nothing added. `usageReport` and
`writeUsageReport` are still there for whoever builds the report from a
snapshot of their own.

```
runs/
├── .gitignore                    written once: git has no business with these
└── 2026-07-19_17-16-48/
    ├── scout-1.html   scout-1.jsonl
    ├── scout-2.html   scout-2.jsonl
    ├── main.jsonl
    └── usage.json
```

The `.gitignore` holds `*`, and it is there because the exports land **inside
the repository the run worked on**. Both halves of that were measured rather
than imagined: a delivery that gives its subtasks copies of the repository
cannot put them back while `runs/` alone makes the tree unclean, and `/build`
ends in a `git add -A`, which would have swept a run's transcripts into
somebody's history. A `.gitignore` already in `runs/` is left alone.

## What is in there, and what is not

- **One HTML and one JSONL per subagent.** An orchestration export that lost the
  subagents' work would be useless.
- **`main.jsonl`** is the parent session's transcript, copied.
- **`main.html` is not there, and will not be.** pi's HTML renderer is a method
  of a live session, and an extension only ever gets a read-only session manager.
  So the JSONL is copied instead, and `pi --export <file>` turns it into the same
  page on demand. Writing our own HTML would mean reimplementing something pi
  already does.
- **`usage.json`** is the only artefact produced here. It carries what pi cannot:
  time, attribution per subagent, and `parallelism` (busy over wall). It is built
  from the same snapshot the TUI draws - one collected state, two consumers.
- **A delegated subagent carries `parentId`**, and the rows come out in tree
  order, so reading top to bottom already shows the children under the one that
  spawned them. The list stays **flat** on purpose: the total is a sum over the
  whole tree either way, and a flat list with a link in it is one pass away from
  a tree without asking every reader to walk one.

## `exportDir` implies a session directory

An in-memory session persists nothing, and pi answers a request to export one
with `Cannot export in-memory session to HTML`. Asking for an export *is* asking
for the session to be kept long enough to export it, so `exportDir` implies
`<exportDir>/.sessions`. That is one decision, not two.

`sessionDir` stays available for anyone who wants the working files elsewhere.
Neither is a default: with no `exportDir`, a subagent leaves nothing behind, not
in `~/.pi` and not in the working directory.

## When it happens

Export can be triggered at any time, not only at the end of a workflow:

```typescript
await subagent.export(dir);   // on any live subagent
```

`close()` exports first and disposes after, so a workflow's `finally` -
cancellation included - is already the "export what was done" path. What is
written on the interrupted path is what makes this feature worth having.

**An export never throws.** Every failure is a string in the result's `error`.
An export is an observer of the run, and an observer that takes the workflow down
with it is a bug, most of all when it runs on the way out of a crash. JSONL and
HTML are attempted separately: an in-memory session still yields its transcript
even though pi refuses to render its page.

## From the extension

```
> use subagent with export true to explore the parser with three scouts
```

The run directory's path is shown in the tool row.

## One run, or a matrix of them

[Experiments](experiments.md) nests this layout one level deeper: a directory per
model, `rep-<n>/` inside it, and each cell writing the very same `usage.json`.

## Reference

- [`measure/export`](../reference/api/measure/export.md) - `createRunDir`, `exportSession`, `usageReport`, `writeUsageReport`.
- [`subagent`](../reference/api/subagent.md) - `Subagent.export`, `SpawnOptions.exportDir`.
