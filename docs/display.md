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

## Picking a reporter

```typescript
import { autoReporter, consoleReporter, silentReporter } from "combo";

onEvent: autoReporter();   // herdr when it is running, silent otherwise
```

`autoReporter()` never warns and never throws: not running under herdr is the
normal case, not a degraded one.

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
to attach, while a pane launches an argv in a real terminal. So the pane does not
host the subagent, it **displays a stream we write**: the library appends to a
file and opens a pane running `tail -n +1 -f` on it, showing tool calls, streamed
text and a final usage line. Splits close on their own when their subagent does,
so a fan-out leaves no orphan panes.

Detection needs `HERDR_ENV=1`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`. All
three, or nothing at all.

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
/herdr on                                            # for this pi session
COMBO_HERDR=all node examples/03-fan-out.ts    # for a whole shell
```

```typescript
createHerdrReporter({ all: true });                  // from a script
```

## The pi TUI

While the subagents work, a dot per subagent sits just above the prompt:

```
● scout#1  grep /lifetime/
  ilaas/qwen-3.6-35b-instruct · ↑12k ↓209 · 12.4s
✓ scout#2  done
  ilaas/qwen-3.6-35b-instruct · ↑8k ↓150 · 8.1s
```

`●` while it works, `✓` when it succeeded, `✗` when it failed, coloured by
status; the dimmed line underneath carries model, tokens and elapsed time,
counting up live. Events alone cannot keep that clock - `usage.busyMs` only
lands when a turn ends - so the widget reads the turn's start and repaints on a
timer. A subagent thinking for twenty seconds emits nothing, and a frozen clock
reads as a hung agent.

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

- [`events`](api/events.md) - `SubagentEvent`, `EventBus`.
- [`reporters/index`](api/reporters/index.md) - `autoReporter`, `combineReporters`.
- [`reporters/herdr`](api/reporters/herdr.md), [`reporters/herdr-client`](api/reporters/herdr-client.md)
- [`reporters/tui`](api/reporters/tui.md) - `createTuiCollector`, `TuiSnapshot`, `widgetRows`.
- [`reporters/console`](api/reporters/console.md), [`reporters/silent`](api/reporters/silent.md)
