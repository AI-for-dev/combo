---
myst:
  html_meta:
    "description": "Twelve sittings in front of pi, each around one problem agents have today, each run on this repository."
---

# Tutorials

The [guide](../guide/quickstart.md) explains combo one concept at a time. These
pages start from the other end: each one sits you in front of pi with a
problem people are having with agents right now, and has you run the thing
that answers it. Every page ends with the question it could not answer, and
the next page opens on it, so they read in order and each one is short.

Everything runs on this repository. Clone it, install, load the extension, and
nothing has to be copied anywhere:

```bash
git clone https://github.com/AI-for-dev/combo && cd combo
npm install
pi -e extension
```

You need a model pi can reach. The frames shown here were drawn by a real pi,
0.85.1, with every subagent on one small open-weight model served locally. A
slow, cheap model is where every weakness shows, and none of what follows
depends on a strong one. Where a page quotes a number, it says what kind of
model produced it; the model column of a frame reads `provider/model`, because
the one these pages ran on is not the one you will have.

## The twelve

**Reading.** The session's context is the scarce thing, and every page here
spends someone else's instead.

1. [A scout reads twenty files so you do not have to](01-one-scout.md) - the
   first subagent, and what your own window looks like afterwards.
2. [Three scouts, one answer](02-three-scouts.md) - `/run explore`: the reading
   in parallel, the answer in your conversation, a failed branch shown rather than
   dropped.
3. [Keep the session out of it](03-keep-the-session-out.md) - `/step`: a chain
   walked by hand, with the main model told nothing until you say so, and a
   different model per step.

**Writing definitions.** Agents are data, workflows are code, and both are
files you can read in a diff.

4. [Write the chain down](04-write-it-down.md) - your first pipeline in
   `.pi/pipelines/`, and what a typo costs.
5. [An agent that cannot do harm](05-an-agent-that-cannot-write.md) - your
   first agent in `.pi/agents/`, why its toolset is the boundary and its prompt is
   not, and why a repository's agents are third-party instructions.
6. [Teach it a house rule](06-teach-it-a-rule.md) - a skill the reviewer opens
   itself, resolved nearest first.

**Writing code.** Agents that argue, and code that runs before anyone signs.

7. [Two agents arguing until LGTM](07-until-lgtm.md) - the loop, the two
   lifetimes, why reaching the cap is not success, and what a verdict is.
8. [Reading code is not running it](08-build.md) - `/build`: a run nobody
   has to sit through, the check whose verdict is final, and the resume.
9. [Two coders, one tree](09-two-coders-one-tree.md) - why several writers
   get a copy each, patches landed one at a time, and nothing rolled back.

**Running it for real.** What it cost, how to stop it, and what the numbers
are worth.

10. [Watch the meter](10-the-meter.md) - the turn that made 79 calls to a tool
    that did not exist, and the three ways to end one.
11. [Same work, two models](11-two-models.md) - an A/B from the prompt line,
    then the honest version: M models, N repetitions, one table.
12. [A subagent that splits its own task](12-a-subagent-with-subagents.md) -
    delegation, its depth, and a bill shaped like a tree.

```{toctree}
:maxdepth: 1
:hidden:

01-one-scout
02-three-scouts
03-keep-the-session-out
04-write-it-down
05-an-agent-that-cannot-write
06-teach-it-a-rule
07-until-lgtm
08-build
09-two-coders-one-tree
10-the-meter
11-two-models
12-a-subagent-with-subagents
```
