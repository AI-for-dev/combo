# A scout reads twenty files so you do not have to

Ask a coding agent where something lives in a repository it has never seen, and
watch the status line. It reads a file, then another, then greps, then reads
five more. Every one of those lands in your session's context and stays there
for the rest of the conversation. Ten questions later the window is half full
of files you never looked at, the model is slower, and it has started to lose
the thing you actually asked for.

A bigger window does not fix that. Somebody else's window does.

## Measure the problem first

Load the extension in this repository:

```bash
pi -e extension
```

The status line above the prompt reads `0.0%/128k`. Watch that percentage.
Ask the session the question the hard way:

```
> find where the wall time of a subagent is measured, and where it is
  displayed. Read the code yourself.
```

It greps, reads, reads again, answers. Look at the status line:

```
↑80k ↓1.8k 18.4%/128k (auto)                          gemma-4-31b • medium
```

One question, and a fifth of the window is gone for the rest of the session.
Every later turn will re-send those files to the model, which is what the
`↑80k` is: input tokens, counted on every request.

## Who is available

Start a fresh pi and ask:

```
/agents
```

```
project · /…/combo/.pi/agents
  auditor      Reads the finished work as a whole and says what still has to change
  coder        Implements a change, and applies review remarks across iterations
  committer    Writes the commit message for finished work
  explorer     Answers a question about a large codebase by splitting the reading across scouts
  interviewer  Turns a vague request into a specification by asking the user one question at a time
  planner      Splits a piece of work into independent subtasks and assigns each one
  reviewer     Reviews code and returns at most five actionable remarks
  router       Picks which agent should handle a task
  scout        Locates the code relevant to a question and reports where it lives
  synthesiser  Merges the findings of several subagents into one answer
user · /home/you/.pi/agent/agents
  (none)
builtin · shipped with combo
  (none)
```

Ten agents, grouped by where their definition came from, most specific first.
In this repository they are listed as `project` because `.pi/agents/` links to
the shipped files; in any other directory the same ten appear under `builtin`,
and either way the extension has them the moment it is loaded. Nothing was
copied to make this work.

Open the one you are about to use. It is a Markdown file:

```bash
cat agents/scout.md
```

```markdown
---
name: scout
description: Locates the code relevant to a question and reports where it lives
tools: read, grep, find, ls
lifetime: task
---

You locate code. You never modify it.
…
```

Four tools, all of them read-only. The next few pages come back to that line.

## The same question, through a scout

Type this at the prompt, as a sentence. The `subagent` tool is one the model
calls, so you ask the model and it fills in the arguments:

```
> use subagent with agent "scout" to find where the wall time of a subagent
  is measured, and where it is displayed
```

While it runs, a dot sits above the prompt:

```
● scout#1  read src/subagent.ts
esc stops everything · ctrl+↑↓ selects · ctrl+del stops the selected one
```

`●` while it works and the tool it is calling right now; as soon as the first
numbers arrive, a dimmed line underneath carries the model it runs on, tokens
up and down, and a clock counting live. When it finishes the dot goes and the
record stays in the tool row:

```
subagent single scout
  Find where the wall time of a subagent is measured and where it is di…
✓ scout#1 Find where the wall time of a subagent is measure…
    … 5 earlier calls
    read src/usage.ts
    read src/reporters/index.ts
    read src/reporters/tui.ts
1 turn 61.2s ↑110k ↓2.5k $0.0000
ctrl+o to expand
```

Eight tool calls, a minute, 110k input tokens. Expand the row and you get all
of it: the task as it was sent, every call, the report rendered as Markdown.
Then the model answers you from the report, in a dozen lines. And the status
line:

```
↑10k ↓94 8.3%/128k (auto)                             gemma-4-31b • medium
```

Same question, same model, same answer in substance. 18.4% against 8.3%, and
most of the 8.3% is pi's own system prompt and the tool's schema, paid once.
The files are in a context that no longer exists. A subagent is a separate
session in the same process, with its own context, and that context dies with
the task. The `↑110k` was spent there.

## What the session does not know

Ask it something only the scout could answer:

```
> which files did the scout open, in order?
```

> I didn't enable the `export` option for the subagent call, so I don't have
> the detailed execution trace or the exact order of file accesses. However,
> based on the final report provided by the scout, it accessed the following
> files (likely in this general order of reasoning): …

That is the right answer, and it knew where the record would have been. The
session holds one report. It never held the files, and it cannot recover what
it never had. Every page after this one builds on that: a subagent inherits
nothing from your session and hands back only its answer.

## A report is a claim

Read the last sentence the scout produced, which the session repeated to you
as fact:

> Notably, the wall time itself is not displayed as a standalone duration;
> only the derived parallelism ratio is shown.

It is false. The clock under the dot, counting up while you watched, is that
duration, and the `61.2s` in the tool row is the same number at rest. The
scout read eight files, found the parallelism ratio in two of them, and
concluded that nothing else was displayed. A small model does this often. A
large one does it less often, and more convincingly.

Nothing in the mechanism protects you from it. What the mechanism gives you is
the record: the calls are in the tool row, and with `export true` on the call
every transcript is on disk. The next page puts three scouts on one question
so that a claim like this one has something to disagree with.

**Next:** [Three scouts, one answer](02-three-scouts.md).
