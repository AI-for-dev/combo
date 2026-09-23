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
  Read the contents of test/fan-out.test.ts and summarize its purpose a…
✓ test-reader#1 Read the contents of test/fan-out.test.ts and sum…
    read test/fan-out.test.ts

1 turn 56.4s ↑5.3k ↓3.2k $0.0000
ctrl+o to expand
```

It never opened the skill. Nothing was loaded eagerly: pi put the skill's
name, its description and its path in the system prompt, and left the model to
`read` the file when the task matched. pi's own documentation says models do
not always do this. On the small open-weight model here, three runs in a row
went straight to the tests; one of them also read `src/workflows/fan-out.ts`,
and none read the list you wrote, one line away.

So the definition has to send it there. Add a sentence to the prompt body:

```markdown
Before you read any test file, open the `assertion-smells` skill and keep its
list beside you: every smell you name comes from it.
```

```
subagent single test-reader
  Read the contents of test/fan-out.test.ts and report them.
✓ test-reader#1 Read the contents of test/fan-out.test.ts and rep…
    read /…/combo/.pi/agents/test-reader/skills/assertion-smells/SKILL.md
    read test/fan-out.test.ts

1 turn 115.1s ↑7.7k ↓4.9k $0.0000
ctrl+o to expand
```

First call, the skill, and the same in the other run with the sentence. The
report that came back was a line per test, twenty of them, each ending on a
word from the list:

> - `returns one result per task, in the order of tasks`: asserts the output
>   of results matches the tasks in order. OK.
> - `accepts one agent per task`: asserts the agents in results match the
>   input agents. Round trip.
> - …
>
> The test whose name promises the most and whose assertion checks the least
> is `accepts one agent per task` (Round trip).

That is the second smell by its name: the test hands the fan-out `scout` and
`coder` and asserts it got `scout` and `coder` back. The other run with the
sentence read the same list and ended every line "no smell", then "No tests
promise more than they check." A skill is a page the model has read. It does
not constrain what the model concludes. The definition can insist, and the
tool row can show you whether it complied, and that is as far as the guarantee
goes.

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
Agent "test-reader" declares unknown skill(s) assertion-smell. Looked in:
/…/combo/.pi/agents/test-reader/skills, /home/you/.pi/agent/skills.
```

Two directories listed and not three, because this repository has no
`.pi/skills/`. What the session did next is worth knowing. It listed
`.pi/agents/test-reader/`, grepped the repository for the name, then called
`edit` on `.pi/agents/test-reader.md` and deleted the `skills:` line, and
called the reader again, which now ran without its rules. The refusal was
exact and the session holds `edit`: it repaired the call by removing the
thing that made it fail. A definition under version control shows that as a
diff; read it before you trust the next report.

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
