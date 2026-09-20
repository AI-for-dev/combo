# Display

Display is an **observer, never a participant**. No workflow may depend on a UI
being present: unplug every reporter and the result is identical.

```typescript
await fanOut({ agent: scout, tasks, onEvent: (event) => console.log(event) });
```

A reporter that throws is swallowed. A broken observer must never take a workflow
down with it.

## The event stream

The core emits, reporters subscribe and only read.

```typescript
type SubagentEvent =
	| { type: "spawn";  id: string; agent: string; lifetime: Lifetime }
	| { type: "status"; id: string; status: "working" | "idle" | "blocked" | "done"; task?: string }
	| { type: "text";   id: string; delta: string }
	| { type: "tool";   id: string; name: string; args: unknown }
	| { type: "post";   id: string; post: Post }
	| { type: "read";   id: string; posts: readonly string[]; waiting: number }
	| { type: "claim";  id: string; key: string; action: "take" | "release"; ok: boolean; heldBy?: string }
	| { type: "steer";  id: string; text: string }
	| { type: "usage";  id: string; usage: Usage }
	| { type: "close";  id: string; result: Result };
```

**The task rides on the `"working"` transition**, not on `spawn`: at spawn time
nobody knows yet what the subagent will be asked, and a persistent subagent is
asked several different things over its life. A reporter has no other way to
learn it, and until it did, every collapsed row in the TUI showed a blank task.

`onEvent` takes a **single** listener, so watching in two places at once means
composing:

```typescript
import { combineReporters, createHerdrReporter, createTuiCollector } from "combo";

const collector = createTuiCollector();
onEvent: combineReporters(collector.reporter, createHerdrReporter());
```

`createHerdrReporter()` returns `undefined` outside herdr, and `combineReporters`
drops it.

**Reading is an event too**, and a [swarm](swarm.md) cannot be read back
without it. The posts say who said what; `read` says who *knew* what, and a
member handed nothing is the strongest thing the record holds about what a
member could not have known. Three members claiming the same file reads as three
models thinking alike until the three reads before them are in the stream.

## Picking a reporter

```typescript
import { autoReporter, consoleReporter, silentReporter } from "combo";

onEvent: autoReporter();   // herdr when it is running, silent otherwise
```

`autoReporter()` never warns and never throws: not running under herdr is the
normal case, not a degraded one.

`consoleReporter()` prints one line per event, board traffic included:

```text
   ⇣ member#3 was handed nothing
   ⚑ member#3 take console.ts → granted
   ⚑ member#2 take console.ts → refused (member#3)
   ✉ member#2 → member#3 [ask] Are you far off on console.ts?
   ⚑ member#3 release console.ts → given back
```

A refusal names the holder: contention has somebody in it, and "refused" alone
cannot tell that from asking for something that was never there. The TUI widget
shows subagents rather than traffic, and says nothing about a board.

## Keeping the stream

```typescript
import { combineReporters, recordReporter } from "combo";

onEvent: combineReporters(autoReporter(), recordReporter("runs/latest/events.jsonl"));
```

One JSON object per line, `{"ts": <ISO 8601>, …event}`, in the order things
happened. pi's own JSONL already holds each subagent's transcript; what this adds
is the two things that live *between* them - the **interleaving** (who was
working while who else was reading) and **our timestamps**, since pi has no
notion of the wall clock a workflow runs on.

Events are recorded verbatim, with no filtering: a recorder that edits its own
record is worse than a large file, and the analysis it exists for is the one
nobody planned in advance. It writes with `appendFileSync` - one syscall per
event, deliberately, because the run worth reading afterwards is the interrupted
one and a buffered stream loses its tail exactly then.

Every [experiment](experiments.md) cell gets one, at `events.jsonl` next to its
`usage.json`. There is no option to turn that off.

## herdr

Inside [herdr](https://herdr.dev), a subagent can get **its own split** and show
what it is doing:

```typescript
await fanOut({
	agent: scout,
	tasks,
	concurrency: 3,
	openInHerdr: true,      // opt-in, per subagent
	onEvent: autoReporter(),
});
```

A herdr pane cannot *host* an in-process subagent: there is no process and no TTY
to attach. So the pane does not host the subagent, it **displays a stream we
write**: the library appends to a file and opens a pane running `tail -n +1 -f`
on it, showing tool calls, streamed text and a final usage line. Splits close on
their own when their subagent does, so a fan-out leaves no orphan panes.

Opening one takes three calls, because herdr has no single call that does all
three: `pane.split` makes the pane beside ours and answers with its id,
`pane.rename` puts the subagent's name on it, and `pane.send_input` types the
`tail` into the shell the split started. `agent.start` sounds like the call
that opens one and is not: it puts a *recognised* agent into a pane that already
exists, and mistaking the two is how `/herdr on` once opened nothing at all
([decisions](../decisions.md)). `node scripts/check-herdr.ts` holds every one of
those calls to `herdr api schema --json`.

Detection needs `HERDR_ENV=1`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`. All
three, or nothing at all. The pane id is what the splits open beside, so they
land next to ours rather than next to whichever pane another client has
focused.

`openInHerdr` is opt-in per subagent, exactly like `lifetime`, so a fan-out of
twenty branches cannot carpet the screen by accident. It can be a default on the
agent itself, which is often what you want:

```markdown
---
name: scout
description: Locates the code relevant to a question
tools: read, grep, find, ls
openInHerdr: true
---
```

The other regime - watch **everything** - belongs to the reporter, not to the
core, because who gets a pane is a display decision and the workflow runs
identically either way:

```bash
/herdr on                              # for this pi session
```

```typescript
createHerdrReporter({ all: true });    // from a script
```

There is no environment variable for it, and there will not be: configuration is
an argument or a command, never something a shell exported three days ago.

`/herdr on` **asks herdr** before answering, and says what it heard:

```text
herdr: every subagent gets its own split
herdr: on, but pi is not running inside herdr - nothing will open
herdr: on, but herdr refused pane.split: missing field `kind` - nothing will open
```

The third line is the one worth having. A herdr that is there and refuses every
request looks exactly like a herdr that works, and the reporter watching it may
not warn about anything at all. The command may, so it is where a refusal gets
said. The probe sends the same `pane.split` a run sends, with a
`target_pane_id` no herdr can have: `pane_not_found` means the request was
understood, anything else is the message above, and neither opens a pane. The
preference is set either way, because what you asked for is not herdr's to
decide.

### The board gets a pane of its own

A [swarm](swarm.md) is the case a pane per member does not cover: what one
member said is in its own pane, and who it was talking to is only legible where
all of them are. So the first thing anybody says opens one more pane, named
`board`, carrying the exchange in order:

```text
⇣ member#2 was handed nothing
✉ member#1 → member#2 [ask] who has console.ts?
⚑ member#2 take console.ts → refused (member#1)
```

Each member's own pane keeps its half of that, without its own name in front of
it - the pane header above already says who it is. The wording is the console
reporter's, from one place (`src/reporters/traffic.ts`), because two displays of
one run are read side by side and a difference between them would read as a
difference in the run.

The pane opens only when the run is being watched at all, closes with the last
member, and carries no herdr *agent*: nobody works in it, so there is nothing to
report a state for and nothing to release.

## Reaching in: the mirror

Every live subagent is registered, by id, with the **mirror**
(`src/mirror.ts`): a unix socket server, one per process, that starts the
first time something asks where it is and goes with the last subagent. A
client attaches by id and speaks newline-delimited JSON:

```text
→ { "attach": "scout#1" }
← { "type": "attached", "id": "scout#1", "agent": "scout", "model": "…", "cwd": "…", "pi": "file:///…/pi-coding-agent/dist/index.js" }
← { "type": "message", "message": … }          // the transcript so far, one per entry
← { "type": "message_start", … }               // then pi's own events, as pi emits them
← { "type": "status", "id": "scout#1", … }     // and ours, around them
→ { "type": "steer", "text": "look at test/ first" }
→ { "type": "abort" }
← { "type": "close", … }                       // then the line goes
```

`attached` names the pi package this process runs, because the events that
follow are that pi's and whatever draws them has to be built from the same
one. A `message_update` arrives per token and carries the whole partial
message, so the mirror sends the latest at most every 50 ms, and always before
whatever follows it.

**A steer is delivered only while the subagent works.** Measured: a steer
queued on an idle session is delivered with the next `prompt()` and answered
*in place of it*, and a follow-up is answered *inside* the next `prompt()`
after the task, so the workflow reads a person's exchange back as its own
result. Between tasks the mirror answers
`{ "type": "refused", "reason": "between tasks - it can only be steered while it works" }`
and queues nothing. `abort` is `stop()`, safe at any moment, and the turn comes
back `stopped` like `/stop`.

Every steer that went through is also a `steer` event on the run's stream, so
the record, the console (`⌨ scout#1 ← look at test/ first`) and a herdr pane
hold that a person spoke. A run somebody steered is not the run they would
have got by watching, and two identical `events.jsonl` must not describe two
different runs.

This is not a reporter. A reporter reads the stream and never reaches the
session; the mirror is a port of the core, beside `ask` and `verify`, and it is
opened by the same act that opens a pane. Unplug every reporter, attach nobody,
and the result is identical.

## The pi TUI

While the subagents work, a dot per subagent sits just above the prompt:

```
● scout#1  grep /lifetime/
  provider/model · ↑12k ↓209 · 12.4s
✓ scout#2  provider/model · ↑8k ↓150 · 8.1s
```

`●` while it works, `✓` when it succeeded, `✗` when it failed, coloured by
status; the dimmed line underneath carries model, tokens and elapsed time,
counting up live. Events alone cannot keep that clock - `usage.busyMs` only
lands when a turn ends - so the widget reads the turn's start and repaints on a
timer. A subagent thinking for twenty seconds emits nothing, and a frozen clock
reads as a hung agent.

**Two lines while it works, one once it is over**, as `scout#2` above. The
second line of a finished subagent held its last tool call, which nobody needs
any more, so its numbers move up beside the tick and the line goes. A fan-out of
three takes seven lines at its widest and shrinks as it finishes, rather than
holding the terminal at its widest until the run ends. A failure keeps what the
tick cannot say: `✗ coder#1  402 from the provider  provider/model · 3.1s`.

A subagent that was **delegated** sits under the one that asked for it, here and
in the tool row alike:

```
● explorer#1  subagent explorer → scout
  provider/model · ↑8k ↓412 · 21.0s
  ● scout#1  read src/reporters/tui.ts
    provider/model · ↑14k ↓980 · 9.4s
```

A row says how deep it sits and the drawing applies the indent, which is the
same split as everywhere else here: the collector lays out, the terminal
decides what a level looks like. A run with no delegation is drawn exactly as
it always was.

### Stopping what you are watching

The dots are also the list of what can be called off. Under them, while
something is still running:

```
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

`esc` stops every subagent of the run. It is **not** intercepted: pi's own
interrupt fires as well, so inside a model's turn the turn goes with the
subagents and the model gets no chance to delegate again. During `/run`,
`/build` or `/step` pi has no turn to abort, and this is what stops them.

The one time it does not is while a question card is up. There `esc` is the
card's, and means "build with what you have": the interviewer that will write
the brief is a subagent of the same run, and a key that stopped it as well
would end the interview it was meant to close. The run's subagents are idle
while a question waits, so nothing is running that the key would have called
off.

`ctrl+↑` and `ctrl+↓` move a `▸` through the subagents that are still working -
delegated children included, in the order the widget draws them - and `ctrl+del`
stops the one it points at. `/stop` does the same by name:

| Command | What it stops |
| --- | --- |
| `/stop` | the selected subagent, or the only one running |
| `/stop <id>` | that one, e.g. `/stop scout#2` |
| `/stop all` | the whole run, like `esc` |

One subagent stopping is **not** the run stopping: its turn comes back as a
failed `Result` reading `stopped`, and what the workflow does next is the
workflow's business - a `fanOut` branch dies alone, while a pipeline step that
fails ends the pipeline. Either way what already ran is kept, and exported.

`/stop` is only typeable while the *model* is running subagents: pi executes an
extension command immediately during a turn, but processes no submission at all
while a slash command of its own is awaiting. That is why the same act has a
key.

The widget disappears the moment the work ends, in a `finally`, so a thrown
workflow never leaves a dead row of dots above the prompt. The full record is one
line below, in the tool row: one line per subagent with its last tool calls.
Expand it - the hint comes from your own keybinding configuration, not a
hard-coded `Ctrl+O` - for the full task, every tool call, the output rendered as
Markdown, and usage per subagent.

A parallel run shows what it achieved (`2/3 done, 1 running`), and a loop says
whether it **converged** or merely ran out of iterations.

## Collection and drawing are separate

The state collector turns the event stream into a snapshot and formats strings,
with no pi-tui import. The extension draws it. Collection is therefore tested by
inspecting a snapshot rather than by scraping a terminal, and the same state
would feed a web view or an export without touching a component.

## Reference

- [`events`](../reference/api/events.md) - `SubagentEvent`, `EventBus`.
- [`reporters/index`](../reference/api/reporters/index.md) - `autoReporter`, `combineReporters`.
- [`mirror`](../reference/api/mirror.md) - `registerMirror`, `mirrorSocket`, the wire.
- [`reporters/herdr`](../reference/api/reporters/herdr.md), [`reporters/herdr-client`](../reference/api/reporters/herdr-client.md)
- [`reporters/tui`](../reference/api/reporters/tui.md) - `createTuiCollector`, `TuiSnapshot`, `widgetRows`.
- [`reporters/record`](../reference/api/reporters/record.md) - `recordReporter`, the event stream on disk.
- [`reporters/console`](../reference/api/reporters/console.md), [`reporters/silent`](../reference/api/reporters/silent.md)
