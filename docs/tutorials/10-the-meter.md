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

- **A missing cost means "not reported", never "free".** The provider in
  these pages reports tokens and no cost, and another one reported no tokens
  at all for a while. The cost is left out rather than printed as `$0.0000`,
  and a table's cost column says `not reported`, because a plausible estimate
  is worse than an honest gap. For the same reason a subagent's line gives no
  tokens while it works through its first turn: pi's counters are read when a
  turn ends, and nothing stands in for them before.
- **`input` counts every request, not every turn.** pi sends the whole prompt
  on each round trip, so a scout that makes seven tool calls sends its growing
  context eight times. The run below has one that read 121k for a single turn.
  That number is right. The turn is the cost, and the counter is telling you
  so.

## Stop one

`/run explore` puts three scouts on one question. While they work, the line
under the plan says what the keys do. `ctrl+↑↓` move a `▸` through the
subagents still working:

```
● explore · 0 visits · 14s
● look · 0/3
  ● look[1]
    ● look[1]/find
      ▸ scout#1  read extension/ui/run.ts:90  provider/model · 13.4s
  ● look[2]
    ● look[2]/find
      ● scout#2  read src/subagent.ts  provider/model · 13.4s
  ● look[3]
    ● look[3]/find
      ● scout#3  read src/subagent.ts  provider/model · 13.4s
○ answer · agent synthesiser (.pi/agents/synthesiser.md) · reads input, look · retry 1 · timeout 30m by default · ≤ 2…
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

`ctrl+del` stops the one it points at:

```
stop: scout#1 stopped - the other subagents are untouched

● explore · 1 visit · 1 failed · 16s · ↑25k ↓714
● look · 1/3
  ✗ look[1] · stopped: scout#1 was stopped · 16s · ↑25k ↓714
  ● look[2]
    ● look[2]/find
      ● scout#2  read src/subagent.ts  provider/model · 15.9s
  ● look[3]
    ● look[3]/find
      ● scout#3  read src/subagent.ts  provider/model · 15.8s
○ answer · agent synthesiser (.pi/agents/synthesiser.md) · reads input, look · retry 1 · timeout 30m by default · ≤ 2…
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

The stopped visit has a bill: its turn ended, by the stop, so pi's counters
were read. The two still working have none yet.

Be quick about it. Twice, on earlier runs of this page, the scout under the
`▸` finished between the two keys, and `ctrl+del` answered with a warning rather
than stopping a subagent that was no longer there:

```
Warning: stop: no subagent `scout#1` is running - try scout#2, scout#3
```

`/stop scout#1` does what `ctrl+del` did, by name. `esc`, or `/stop all`, stops every
subagent of the run, and the run with them.

One subagent stopping is **not** the run stopping, and what happens next is
the flow's business. The scouts' `retry: 1` does not cover a stop: a person
pressing a key is not a failure to try again, so `look[1]` stayed failed.
`explore` marks its scouts `on-fail: continue`, so the map ended with one
failed item, and the synthesiser was handed the two reports and the failure:

```
✓ explore · 5 visits · 1 failed · 1m25s · ↑168k ↓6.6k
✓ look · 3 items · 1 failed · 1m18s · ↑166k ↓5.6k
✓ answer · synthesiser · 7s · ↑2.1k ↓948
```

Its answer did not say that a third of the reading was missing. It said that
the wall time "is generally not shown as a standalone duration for a subagent
and is primarily used internally for calculations such as parallelism", and
named its source: `docs/tutorials/10-the-meter.md`, this page. `scout#3`'s
grep had matched the paragraph you are reading, as an earlier run of this
page wrote it: it quoted an earlier synthesiser's claim in order to refute
it, and the scout handed the quote on as the documentation. The clock on every
line above is that duration. The scout that was stopped was the one sent to
find where the wall time is implemented, and it was reading
`extension/ui/run.ts`, the live view, when the key landed.

## Read the bill

Every `/run` leaves a `usage.json` in its run directory, and so do `/step` and
the `subagent` tool, with `export true` or a flow. That run's, cut short and
its times rounded to the millisecond:

```json
{
	"wallMs": 84516,
	"total": { "wallMs": 84516, "busyMs": 117984, "turns": 4, "input": 168037, "output": 6564, "cost": 0, "subagents": 4, "failed": 1 },
	"parallelism": 1.396,
	"subagents": [
		{ "id": "scout#1", "agent": "scout", "model": "provider/model", "ok": false, "error": "stopped", "toolCalls": 4,
		  "usage": { "wallMs": 15847, "turns": 1, "input": 24792, "output": 714, "cost": 0 }, "home": "look[1]/find", "life": 1 }
	],
	"visits": [
		{ "path": "look", "node": "look", "kind": "map", "life": 1, "ok": true, "wallMs": 77871, "usage": { "input": 165961 } },
		{ "path": "look[1]/find", "node": "look/find", "kind": "agent", "agent": "scout", "subagent": "scout#1", "life": 1, "ok": false, "wallMs": 15870 },
		{ "path": "look[3]/find", "node": "look/find", "kind": "agent", "agent": "scout", "subagent": "scout#3", "life": 1, "ok": true, "wallMs": 17706 },
		{ "path": "look[2]/find", "node": "look/find", "kind": "agent", "agent": "scout", "subagent": "scout#2", "life": 1, "ok": true, "wallMs": 77871 },
		{ "path": "answer", "node": "answer", "kind": "agent", "agent": "synthesiser", "subagent": "synthesiser#1", "life": 1, "ok": true, "wallMs": 6643 }
	],
	"nodes": [
		{ "node": "look", "visits": 1, "wallMs": 77871 },
		{ "node": "look/find", "visits": 3, "wallMs": 111446 },
		{ "node": "answer", "visits": 1, "wallMs": 6643 }
	],
	"lives": [
		{ "startedAt": "2026-09-24T04:00:28.178Z", "wallMs": 84516, "end": "ok" }
	]
}
```

Four lists, each linked to the others by path and id:

- **`subagents`**, one per subagent, the stopped one included with its bill.
  A scout stopped after 25k tokens cost 25k tokens, and dropping it would make
  an expensive failure read as a cheap run.
- **`visits`**, one per visit of the flow, every kind included: a `check` or
  an `ask` has its time and no tokens. A visit holds the visits inside it, so
  `look` is the three scouts, and the three `find`s come after it in the order
  they ended.
- **`nodes`**, one per node of the file, summed over its visits: `look/find`
  ran three times for 111 seconds of work.
- **`lives`**, one per process that ran it. This one had a single life. The
  build of [page eight](08-build.md) that was killed and resumed has two, the
  first `"end": "interrupted"` and `"partial": true`: rebuilt from its journal,
  it counts the visits it ended and nothing of the review it was cut in.

`parallelism` is busy over wall: 118 seconds of work in 85. A fan-out of three
that reads 1.40 has its slowest branch setting the pace: `scout#2` read for 78
seconds, and the other two had stopped or finished before 18. That ratio is
the only number that says whether the fan-out bought anything.

## Set the deadline

A turn's bound is `--timeout` on the command line, else the node's
`timeout:`, else the flow's, else 30 minutes. It bounds one turn, not the run:
a map of three gets three deadlines, a loop one per turn per iteration. A
`check` has its own `timeout:` and nothing else reaches it.

```
/run --timeout 20s explore how is the wall time of a subagent measured, and where is it shown --model <provider/model>
```

Twenty seconds is too short for these scouts, on purpose. Each turn was cut
through pi's own abort, and a timeout is one of the failures `retry: 1`
covers, so each visit was asked twice, the second time by a fresh scout given
the whole turn again. Both attempts ran out of time, and each visit ended
failed, with what its two attempts had spent, as the run's journal has it:

| visit | scouts | error | turns | input |
| --- | --- | --- | --- | --- |
| `look[1]/find` | scout#1, scout#5 | `timeout: timed out after 20s` | 2 | 13,028 |
| `look[2]/find` | scout#2, scout#4 | `timeout: timed out after 20s` | 2 | 33,657 |
| `look[3]/find` | scout#3, scout#6 | `timeout: timed out after 20s` | 2 | 20,204 |

```
✓ explore · 5 visits · 3 failed · 42s · ↑68k ↓3.2k
✓ look · 3 items · 3 failed · 41s · ↑67k ↓3.1k
✓ answer · synthesiser · 2s · ↑1.3k ↓138
```

Six scouts for three items, forty seconds a visit. The retry doubled what a
too-short deadline costs, and it could not have saved a turn that needs more
than twenty seconds: raise the deadline instead. The synthesiser, handed three
failures, said so: "All three reports failed due to timeouts, so there is no
information available on how the wall time of a subagent is measured or where
it is shown." The
run is `ok` because the flow decided that a failed scout is a value, not an
end; the `1 failed` and `3 failed` on its lines are how you tell.

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
