# An agent that cannot do harm

![An agent that cannot do harm](../_static/tutorials/05-an-agent-that-cannot-write.svg)

Every agent framework has the same paragraph in its documentation: "instruct
the agent not to modify files it was not asked to". Here is what that
paragraph is worth. An example in this repository once gave its coder the full
toolset and asked it, in the system prompt, to change nothing. In a plain demo
run it edited `src/usage.ts`. Twice.

A prompt is not a permission boundary. The toolset is. The agent you are about
to write starts from what it may not do.

## The problem worth an agent

Test names lie. `test("handles errors correctly")` asserts that a function
returns without throwing, and a reviewer reading the name signs off on error
handling nobody tested. Reading assertions one by one is tedious, and tedious
is what a small model is good at.

Write `.pi/agents/test-reader.md`:

```markdown
---
name: test-reader
description: Reads a test file and reports what each test really asserts, against what its name promises
tools: read, grep, find, ls
lifetime: task
---

You read tests. You never write code, and you never run anything.

Given a test file, go through every test in it and report, one line each:
its name, what it actually asserts, and whether the name promises more than
the assertion checks. A test that only asserts "does not throw" or asserts on
a value it set up itself is worth naming.

Read the code under test when you need to know whether an assertion is
meaningful. End with the two or three tests whose name promises the most and
whose assertion checks the least.
```

Three fields matter more than the prose.

`tools:` is an allowlist pi enforces. This agent holds `read`, `grep`, `find`
and `ls`. There is no `write`, no `edit`, no `bash`, so there is nothing to
instruct it not to do; leaving `tools:` out gives the same four, which is the
default for anything that explores.

`description:` is not decoration. It is what a router reads to pick an agent,
and what a planner reads to assign it a subtask. A vague description produces
vague routing, and no parser repairs that.

`lifetime: task` says a fresh one is spawned per call and closed after. Ask
twice, get two readers who never met.

## See it, and use it

```
/agents
```

```
project · /…/combo/.pi/agents
  …
  synthesiser  Merges the findings of several subagents into one answer
  test-reader  Reads a test file and reports what each test really asserts, against what its name promises
user · /home/you/.pi/agent/agents
  (none)
builtin · shipped with combo
  (none)

A project agent needs scope "project" or "both" from the subagent tool. /run and /step load all three.
```

It is listed under `project` because it lives in the repository, and the last
line is the rule that group has and the other two do not. Hence the scope in
the call:

```
> use subagent with scope "project" and agent "test-reader" to read
  test/loop.test.ts
```

A repository's `.pi/agents/` is repository-controlled content. Its prompts are
instructions written by whoever committed them, and a clone you just pulled is
a stranger's file until you have read it. So project agents are **never loaded
by default**: the `subagent` tool reads the shipped agents and yours from
`~/.pi/agent/agents/`, and a repository's only when the call says `scope:
"project"` or `"both"`. `/run` and `/step` load all three, because a person
typing a command inside a repository is the explicit request. Asking is one
word. Being handed a stranger's instructions by surprise is not acceptable,
and the boundary is a security decision rather than a preference.

It read one file, for fifty seconds on a small model, and came back with a
line per test:

```
subagent single test-reader
  Read the contents of test/loop.test.ts and summarize its purpose and …
✓ test-reader#1 Read the contents of test/loop.test.ts and summar…
    read test/loop.test.ts

1 turn 51.5s ↑4.8k ↓2.1k $0.0000
ctrl+o to expand
```

> - caps the loop, and defaults to 5: asserts that the loop stops at
>   `maxIterations` and that the default is 5. No.
> - hitting the cap is reported as not converged, even when every turn was
>   fine: asserts that reaching the iteration limit results in `converged:
>   false` while `ok: true`. No.
> - …
>
> The tests in this file are consistently precise. If any promise more than
> they check, it is:
> - an async until is awaited: the judge is often a test run: the "awaited"
>   part is mostly implicit in the test's successful completion.
> - rejects a cap below 1: an unrunnable loop is a programming error: the
>   "programming error" part is a conceptual justification rather than a
>   checked property.

Seventeen tests, seventeen lines, two named at the end. Whether it is right
about those two is a question for whoever wrote them. It did the tedious part
and left the judgement where it belongs.

Read the second line of the row, though: that is not what you typed. The
session wrote the task it sent, "Read the contents of test/loop.test.ts and
summarize its purpose and key test cases", and then summarised the report
back to you by theme, the two names at the end left out. The row is how you
know: it shows the task as it was sent, and `ctrl+o` shows the report as it
came back.

## Try to make it write

Now ask for the thing it cannot do, in a fresh session:

```
> use subagent with scope "project" and agent "test-reader" to read
  test/loop.test.ts and rename any test whose name overpromises
```

The first time, on a small open-weight model, the session passed the request
on as written. The reader, which cannot rename anything, answered that "none
of them overpromise", and the session reported that "no renames were
performed". The same reader had named two tests a moment earlier.

The second time, same model, same sentence, its thinking went the other way:

> Then I will need to apply those renames to the file.

It rewrote the task into "identify any test names that overpromise … Suggest
better, more realistic names for them", got one name back, and called `edit`
itself:

```bash
git diff
```

```diff
@@ -157,7 +157,7 @@ describe("loop", () => {
 			assert.equal(fake.asks.filter((ask) => ask.id === reviewerId).length, 3);
 		});
 
-		test('"task": brand new subagents at every iteration, no accumulated bias', async () => {
+		test('"task": brand new subagents at every iteration', async () => {
 			const fake = fakeSpawn();
 			await loop({ steps: [coder, reviewer], input: "x", maxIterations: 3, lifetime: "task", spawn: fake.spawn });
```

The boundary held where it was drawn, both times: the agent you wrote could
not write, and did not. The agent you did not write, the one you are typing
into, has every tool your pi gives it and a request from you that said
"rename". A toolset bounds the agent that holds it and nobody else. If the
working tree must not change, do not ask the session that can change it.
`/run` and `/step` put no model between you and the subagent, so there is
nothing to route around.

The other thing that can happen is the one to plan for. A model calls a tool
its session does not hold anyway. pi refuses it, the model gets an error back,
and it tries again. The reviewer in [the chain two pages back](03-keep-the-session-out.md)
did exactly that: its prompt mentions a `verdict` tool, a plain `/step` does
not hand one over, and its transcript holds five calls to `verdict`, each
answered `Tool verdict not found`, before the prose you saw. That retry is the argument for a deadline on every call, which is what
[watch the meter](10-the-meter.md) is about. Widening the allowlist to stop
the retries is the one fix that is always wrong.

## Whose name wins

Write a file called `scout.md` in `.pi/agents/` and the shipped `scout` is
gone from this repository, replaced by yours. Precedence runs from the least
specific to the most: shipped, then `~/.pi/agent/agents/`, then the
repository's. Nothing is removed to override something, and `/agents` shows a
name once, under the source that won it.

The other way round is a guarantee worth knowing: the extension **can never
take a name from you**. Its agents sit at the lowest priority by construction.

## What it inherits from you

Nothing. The system prompt is the file's body, through combo's own resource
loader: none of your extensions, none of your context files, none of your
settings, not even the model your pi is running on. Two lines are appended,
and neither is inherited state: where it stands (its working directory,
without which a model guesses a path and gives up) and which language to
answer in (the one the work is written in).

Everything an agent can do is therefore readable in its own file: the tools it
holds, the model it will run on if it names one, how long it lives. The next
page relies on that when it teaches this agent a rule.

Not everything an agent should know fits in a system prompt. A checklist of
assertion smells is a page, and it is the same page for every agent that reads
tests.

**Next:** [Teach it a house rule](06-teach-it-a-rule.md).
