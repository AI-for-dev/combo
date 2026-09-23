# Watch the meter

![Watch the meter](../_static/tutorials/10-the-meter.svg)

Observed in the wild, on a small model: 79 calls to a tool named `run`, which
did not exist. Each call got "unknown tool" back, and each time the model
asked again, sending the whole context with it. Around 500k input tokens in a
single turn, and nothing at the end of it.

pi's agent loop is a `while (true)` with no step cap. That is the right design
for an agent loop and the wrong thing to run unattended, which is why a turn
here always has a deadline, and why it is yours to set.

## Where the numbers come from

Nothing here is estimated. Tokens and cost come from pi's own session
statistics, which are cumulative, so a turn's usage is the difference between
two snapshots, clamped at zero because compaction can walk the totals back.
Time is ours, on a monotonic clock.

Two consequences you have already seen and may not have read:

- **`$0.0000` means "not reported", never "free".** The provider in these pages
  reports tokens and no cost, and another one reported no tokens at all for a
  while. A zero is printed rather than a number counted from characters,
  because a plausible estimate is worse than an honest gap. For the same
  reason a subagent's line reads `↑0 ↓0` while it works: pi's counters are
  read when a turn ends, and nothing stands in for them before.
- **`input` counts every request, not every turn.** pi sends the whole prompt
  on each round trip, so a scout that makes seven tool calls sends its growing
  context eight times. The run below has one that read 75k for a single turn.
  That number is right. The turn is the cost, and the counter is telling you
  so.

## Stop one

`/run explore` puts three scouts on one question. While they work, the line
under the plan says what the keys do. `ctrl+↑↓` move a `▸` through the
subagents still working:

```
● explore · 1 visit · 20s · ↑19k ↓1.9k
● look · 1/3
  ● look[1]
    ● look[1]/find
      ▸ scout#1  read src/measure/measured.ts  provider/model · ↑0 ↓0 · 39.0s
  ● look[2]
    ● look[2]/find
      ● scout#2  read test/export.test.ts  provider/model · ↑0 ↓0 · 39.0s
  ✓ look[3] · 20s · ↑19k ↓1.9k
○ answer · agent synthesiser (.pi/agents/synthesiser.md) · reads input, look · timeout 30m by default · ≤ 1 turn · ≤ …
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

`ctrl+del` stops the one it points at:

```
stop: scout#1 stopped - the other subagents are untouched

● explore · 2 visits · 1 failed · 59s · ↑76k ↓3.7k
● look · 2/3
  ✗ look[1] · stopped: scout#1 was stopped · 40s · ↑57k ↓1.8k
  ● look[2]
    ● look[2]/find
      ● scout#2  read test/export.test.ts  provider/model · ↑0 ↓0 · 39.0s
  ✓ look[3] · 20s · ↑19k ↓1.9k
○ answer · agent synthesiser (.pi/agents/synthesiser.md) · reads input, look · timeout 30m by default · ≤ 1 turn · ≤ …
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

`/stop scout#1` does the same by name. `esc`, or `/stop all`, stops every
subagent of the run, and the run with them.

One subagent stopping is **not** the run stopping, and what happens next is
the flow's business. `explore` marks its scouts `on-fail: continue`, so the
map ended with one failed item, and the synthesiser was handed the two reports
and the failure:

```
✓ explore · 5 visits · 1 failed · 57s · ↑154k ↓6.9k
✓ look · 3 items · 1 failed · 53s · ↑151k ↓6.2k
✓ answer · synthesiser · 5s · ↑2.2k ↓679
```

Its answer did not say that a third of the reading was missing, and it ended
on a sentence you have met on [the first page](01-one-scout.md): the wall
time "is not displayed as a standalone duration in the UI". The clock on every
line above is that duration. The scout that went looking for where it is
implemented was the one stopped.

## Read the bill

Every `/run` leaves a `usage.json` in its run directory, and so do `/step` and
the `subagent` tool, with `export true` or a flow. That run's, cut short and
its times rounded to the millisecond:

```json
{
	"wallMs": 56714,
	"total": { "wallMs": 56714, "busyMs": 114793, "turns": 4, "input": 153551, "output": 6868, "cost": 0, "subagents": 4, "failed": 1 },
	"parallelism": 2.024,
	"subagents": [
		{ "id": "scout#1", "agent": "scout", "model": "provider/model", "ok": false, "error": "stopped", "toolCalls": 7,
		  "usage": { "wallMs": 39031, "turns": 1, "input": 56919, "output": 1840, "cost": 0 }, "home": "look[1]/find", "life": 1 }
	],
	"visits": [
		{ "path": "look", "node": "look", "kind": "map", "life": 1, "ok": true, "wallMs": 52060, "usage": { "input": 151305 } },
		{ "path": "look[3]/find", "node": "look/find", "kind": "agent", "agent": "scout", "subagent": "scout#3", "life": 1, "ok": true, "wallMs": 19163 },
		{ "path": "look[1]/find", "node": "look/find", "kind": "agent", "agent": "scout", "subagent": "scout#1", "life": 1, "ok": false, "wallMs": 39058 },
		{ "path": "look[2]/find", "node": "look/find", "kind": "agent", "agent": "scout", "subagent": "scout#2", "life": 1, "ok": true, "wallMs": 52058 },
		{ "path": "answer", "node": "answer", "kind": "agent", "agent": "synthesiser", "subagent": "synthesiser#1", "life": 1, "ok": true, "wallMs": 4650 }
	],
	"nodes": [
		{ "node": "look", "visits": 1, "wallMs": 52060 },
		{ "node": "look/find", "visits": 3, "wallMs": 110280 },
		{ "node": "answer", "visits": 1, "wallMs": 4650 }
	],
	"lives": [
		{ "startedAt": "2026-09-23T22:16:53.366Z", "wallMs": 56714, "end": "ok" }
	]
}
```

Four lists, each linked to the others by path and id:

- **`subagents`**, one per subagent, the stopped one included with its bill.
  A scout stopped after 57k tokens cost 57k tokens, and dropping it would make
  an expensive failure read as a cheap run.
- **`visits`**, one per visit of the flow, every kind included: a `check` or
  an `ask` has its time and no tokens. A visit holds the visits inside it, so
  `look` is the three scouts, and the three `find`s come after it in the order
  they ended.
- **`nodes`**, one per node of the file, summed over its visits: `look/find`
  ran three times for 110 seconds of work.
- **`lives`**, one per process that ran it. This one had a single life. The
  build of [page eight](08-build.md) that was killed and resumed has two, the
  first `"end": "interrupted"` and `"partial": true`: rebuilt from its journal,
  it counts the visits it ended and nothing of the review it was cut in.

`parallelism` is busy over wall: 115 seconds of work in 57. A fan-out of three
that reads 2.02 has its slowest branch setting the pace, and that ratio is the
only number that says whether the fan-out bought anything.

## Set the deadline

A turn's bound is `--timeout` on the command line, else the node's
`timeout:`, else the flow's, else 30 minutes. It bounds one turn, not the run:
a map of three gets three deadlines, a loop one per turn per iteration. A
`check` has its own `timeout:` and nothing else reaches it.

```
/run --timeout 20s explore how is the wall time of a subagent measured, and where is it shown --model <provider/model>
```

Twenty seconds is too short for these scouts, on purpose. Each turn was cut
through pi's own abort, and each visit ended failed, with what it had spent,
as the run's journal has it:

| visit | error | input |
| --- | --- | --- |
| `look[1]/find` | `timeout: no answer within 20000 ms` | 23,335 |
| `look[2]/find` | `timeout: no answer within 20000 ms` | 4,542 |
| `look[3]/find` | `timeout: no answer within 20000 ms` | 24,904 |

```
✓ explore · 5 visits · 3 failed · 22s · ↑54k ↓2.3k
✓ look · 3 items · 3 failed · 21s · ↑53k ↓2.2k
✓ answer · synthesiser · 2s · ↑1.4k ↓122
```

The synthesiser, handed three failures, said so: "None of the reports provide
any information on how the wall time of a subagent is measured or where it is
shown, as they all failed due to timeouts." The run is `ok` because the flow
decided that a failed scout is a value, not an end; the `1 failed` and
`3 failed` on its lines are how you tell.

A loop has a cap of its own, `max:`, and a `map-from` list a `max:` of its own
too, both required. A turn's deadline has a default and a loop's cap does not,
because "forever" must not be reachable by forgetting an argument, and a cap
you had to write is one you know.

## Watch it somewhere else

Inside [herdr](https://herdr.dev), `/herdr on` gives every subagent of this
session its own split, showing tool calls and streamed text as they happen. A
pane cannot host an in-process subagent, so the library writes a stream to a
file and the pane tails it; splits close on their own when their subagent
does. Outside herdr the command has nothing to do, and says so.

A bill for one run tells you what one run cost. It does not tell you whether
the model was worth it. Only the same work on another model can.

**Next:** [Same work, two models](11-two-models.md).
