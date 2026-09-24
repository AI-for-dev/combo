# Teach it a house rule

![Teach it a house rule](../_static/tutorials/06-teach-it-a-rule.svg)

The test-reader from the last page knows what a test is. It does not know
what your team means by a bad one, and neither does any model: "asserts on a
value it set up itself" is a house rule, one of a dozen, and the list is the
same for every agent that will ever read a test here. Pasting it into each
system prompt is how three copies drift apart.

A skill is that list as a file, named by the agents that may use it, and
opened by the model when it needs it. This page gives the test-reader one and
watches whether it reads it.

## Write it beside the agent

```bash
mkdir -p .pi/agents/test-reader/skills/assertion-smells
```

```markdown
---
name: assertion-smells
description: A checklist of assertions that check less than their test's name promises. Use when reading a test file.
---

# Assertion smells

Go through this list for every test. Name the smell, not the number.

1. **Existence only.** `assert.ok(result)` on a value that cannot be falsy.
   The test proves the function returned.
2. **Round trip.** Asserts equality with a value the test itself put in a
   fake. The test proves the fake works.
3. **No negative case.** A test named "rejects", "refuses" or "fails" that
   never asserts on the error, only that something happened.
4. **Cap without convergence.** A loop or retry test asserting the count of
   iterations and not what the last one produced.
5. **Order not asserted.** A test named "in order" that asserts on membership.
6. **Elapsed not asserted.** A timeout test that asserts the error message
   and never the time it took: a correct label on a hanging turn is not a guard.
```

That is pi's own skill format, `SKILL.md` with a `name` and a `description`,
in `.pi/agents/test-reader/skills/`. The directory is chosen for you: the
definition minus its `.md`, then `skills/`. `agents/scout.md` keeps its skills
in `agents/scout/skills/`, so a definition and what it cannot work without
travel together, and a clone of the repository resolves the same names.

Then name it in the agent:

```markdown
---
name: test-reader
description: Reads a test file and reports what each test really asserts, against what its name promises
tools: read, grep, find, ls
skills: assertion-smells
lifetime: task
---
```

`skills:` is an allowlist exactly like `tools:`. An agent that names nothing
gets nothing, whatever is installed on the machine, so what an agent can reach
stays readable in its own file.

## Watch whether it opens it

```
> use subagent with scope "project" and agent "test-reader" to read
  test/fan-out.test.ts
```

```
subagent single test-reader
  read test/fan-out.test.ts
✓ test-reader#1 read test/fan-out.test.ts
    read test/fan-out.test.ts

1 turn 60.5s ↑5.3k ↓2.4k
ctrl+o to expand
```

It never opened the skill. Nothing was loaded eagerly: pi put the skill's
name, its description and its path in the system prompt, and left the model to
`read` the file when the task matched. pi's own documentation says models do
not always do this. On the small open-weight model here it went straight to
the tests, never read the list you wrote, one line away, and ended "No tests
promise more than they check."

So the definition has to send it there. Add a sentence to the prompt body:

```markdown
Before you read any test file, open the `assertion-smells` skill and keep its
list beside you: every smell you name comes from it.
```

```
subagent single test-reader
  read test/fan-out.test.ts
✓ test-reader#1 read test/fan-out.test.ts
    read /…/combo/.pi/agents/test-reader/skills/assertion-smells/SKILL.md
    read test/fan-out.test.ts

1 turn 12.8s ↑7.5k ↓2.2k
ctrl+o to expand
```

First call, the skill. The report that came back was a line per test, twenty
of them, and not one named a smell:

> - returns one result per task, in the order of tasks: asserts that result
>   outputs match task order regardless of completion speed.
> - accepts one agent per task: asserts that each result is associated with
>   the corresponding agent.
> - …
>
> No tests promise more than they check.

`accepts one agent per task` is the second smell on the list, a round trip:
the test hands the fan-out `scout` and `coder` and asserts it got `scout` and
`coder` back. The reader had the list in front of it and did not see it. A
skill is a page the model has read. It does not constrain what the model
concludes. The definition can insist, and the tool row can show you whether it
complied, and that is as far as the guarantee goes.

## Where a name resolves

Three places, **nearest first**, and the first one that has the name wins:

1. `.pi/agents/test-reader/skills/` - beside the definition. Reproducible.
2. `.pi/skills/` in the repository, found by walking up from the working
   directory. Reproducible, and shared by every agent in the repository.
3. `~/.pi/agent/skills/` - yours. A convenience that depends on the machine.

That third one is the deliberate hole in "a subagent inherits nothing": the
name still has to be written in the definition, but where it resolves can
depend on whose machine the run is on. A skill the agent cannot work without
belongs in the first place, not the third.

## What fails, and when

At spawn, and by name. Misspell it, `skills: assertion-smell`, and the call
does not start:

```
subagent single test-reader
  read test/fan-out.test.ts
Agent "test-reader" declares unknown skill(s) assertion-smell. "assertion-smell": did you mean "assertion-smells"?
Skills found: assertion-smells. Looked in:
/…/combo/.pi/agents/test-reader/skills, /home/you/.pi/agent/skills.
```

The refusal says what it found as well as where it looked: the skills in
those directories, and the nearest name among them. Two directories are listed
and not three, because this repository has no `.pi/skills/`. A skill goes by
the `name:` in its `SKILL.md`, not by its directory, so renaming a directory
never fixes a refusal. If a directory named `assertion-smell` held a
`SKILL.md` saying `name: assertion-smells`, the message would say exactly that.

The session read the hint. It ran `find` for the agent's files, read
`.pi/agents/test-reader.md`, and called `edit` to change
`skills: assertion-smell` to `skills: assertion-smells`. On the second call the
reader opened the skill first, as its prompt asks, and reported twenty tests
without naming a single smell, `accepts one agent per task` included. The edit
was the right one, and it was still a session rewriting an agent's definition
to get past a refusal: it holds `edit` and `bash`, and it did not ask before
editing. Under version control that shows as a one-word diff; read it before
you trust the next report.

Two more refusals, both for a skill that would resolve and never be seen: an
agent whose `tools:` lacks `read` cannot open the file, and pi drops the whole
skills section from its prompt, so combo refuses at spawn rather than let the
agent run without it. And a skill whose frontmatter sets
`disable-model-invocation` is kept out of the system prompt by pi, so the agent
would never know it existed. A flow naming the agent is refused the same way,
before its first turn, with `unknown-skill`, `skills-without-read` or
`skill-hidden`. Finding out through prose that quietly lacks a step costs more
than failing at once.

You now have an agent that cannot write, reads by your rules, and tells you
when its rules are missing. It is half of a loop. The other half writes, and
has to be argued with.

**Next:** [Two agents arguing until LGTM](07-until-lgtm.md).
