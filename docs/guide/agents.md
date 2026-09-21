# Agents

An agent is **data**: a system prompt, a model, a set of tools. It is declared in
Markdown with frontmatter, following pi's own convention, and it holds no state.
Bringing one to life is `spawn()`'s job, and that produces a
[subagent](lifetime.md).

```markdown
---
name: reviewer
description: Reviews code and returns actionable remarks
tools: read, grep, find, ls
model: anthropic/claude-sonnet-5
lifetime: workflow
openInHerdr: true
---

You review the code produced and return at most 5 remarks…
```

The Markdown body is the system prompt, used verbatim.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | How every caller refers to the agent. |
| `description` | yes | One line on what it is for. Also what `route` and `orchestrate` read to decide who does the work. |
| `tools` | no | Allowed tools. Absent means read-only: `read`, `grep`, `find`, `ls`. |
| `skills` | no | Skills it may load, by name. Absent means none - see below. |
| `concurrency` | no | How many subagents it runs at once when it delegates. Only read for an agent that names `subagent`. |
| `model` | no | A pattern such as `anthropic/claude-sonnet-5`. A caller's `model` argument beats it; absent everywhere means pi's default - see below. |
| `lifetime` | no | Default [lifetime](lifetime.md). An explicit argument always wins. |
| `openInHerdr` | no | Default for "give this agent its own herdr split". See [Display](display.md). |

A file missing `name` or `description` is **ignored silently**. That is pi's
behaviour and it is kept.

`description` is not decoration. A vague one produces vague routing, and no
parser can repair that.

## Where they are loaded from

```typescript
import { findAgent, loadAgents } from "@ai-for-dev/combo";

const agents = loadAgents();                       // ~/.pi/agent/agents/ only
const both = loadAgents({ scope: "both" });        // plus .pi/agents/
const reviewer = findAgent(agents, "reviewer");    // throws on an unknown name
```

- `"user"` (the default) reads `~/.pi/agent/agents/`.
- `"project"` reads `.pi/agents/` of the current repository.
- `"both"` reads the two.

There is a third source, off by default: the agents **shipped with this
package** (`scout`, `coder`, `reviewer`, `planner`, `router`, `synthesiser`,
`interviewer`, `auditor`, `committer`, `explorer`, `member`). Pass `builtin: true` to include them -
which the pi extension always does, because otherwise its commands only work
inside a repository where someone has already copied the definitions by hand.

**Precedence runs from the least specific to the most**: shipped, then yours,
then the repository's. Whoever is closer to the work wins the name, so writing
your own `scout.md` replaces ours without having to remove anything.

```typescript
loadAgents({ scope: "both", builtin: true });
```

It is off by default for scripts on purpose: asking for "the user's agents" must
not hand you ours as well.

**Project agents are never loaded by default**, and that is a security boundary
rather than a preference: `.pi/agents/` is repository-controlled content, so its
instructions are third-party instructions. Asking for them is one word; getting
them by surprise is not acceptable.

`findAgent` throws on an unknown name, deliberately: a typo in a workflow should
fail immediately, not three steps later as a failed `Result`. When no agent is
found at all, the error says so in terms of scope, because that is nearly always
the cause.

Agents are rediscovered on every call, so editing a `.md` file is enough to
reload it.

## Seeing what you have

```
/agents
```

```
project · /repo/.pi/agents
  scout        Locates the code relevant to a question and reports where it lives
user · /home/you/.pi/agent/agents
  (none)
builtin · /repo/agents
  coder        Implements a change, and applies review remarks across iterations
  reviewer     Reviews code and returns at most five actionable remarks

A project agent needs scope "project" or "both" from the subagent tool. /run and /build load all three.
```

Grouped by where each definition came from, most specific first, because that is
half of what is being asked: an agent nobody can find is usually one whose scope
is not the one being loaded. A source that turned up nothing still names the
directory it looked in, which is where yours would go. A name defined twice
appears once, under the source that won it.

## Tools, and why a prompt is not a boundary

A subagent that must not write must not *have* `write` and `edit`. Asking it
nicely in the system prompt does not work. This is not a hypothetical: an example
in this repository once gave its coder the full toolset and merely asked it to
change nothing. It edited `src/usage.ts` anyway, twice, in a plain demo run.

```markdown
---
name: scout
description: Locates the code relevant to a question
tools: read, grep, find, ls
---
```

Read-only is the recommended default for anything that explores. The allowlist is
genuinely enforced by pi. A weak model will still *emit* calls to tools it does
not have; those fail, and the model may retry them in a loop, which is an
argument for `loop`'s `maxIterations` and for `timeoutMs`, not for widening the
allowlist.

## Tools combo brings

Some names in `tools:` are not pi's. `verdict` is combo's, and a reviewer that
names it is handed it by [`pair`](workflows.md) so it can declare its decision as
a call rather than as a word in its prose.

`subagent` is combo's too, and an agent that names it can split its task across
children of its own. Two levels deep by default, and the roster it may reach is
the caller's to pass.

`board` is the third, and a [swarm](swarm.md) hands it to every member whose
`tools:` names it: post what you found, read what the others posted, take a key
before writing to it. Who is posting is in the closure rather than in the
parameters, so a member cannot post as another one. A member that does not name
`board` still runs, and cannot reach the others, which makes that run a
fan-out.

**How wide it splits is the agent's own**, declared as `concurrency:` in its
frontmatter:

```markdown
---
name: explorer
description: Answers a question by splitting the reading across scouts
tools: read, grep, find, ls, subagent
concurrency: 3
---
```

That number belongs in the file rather than at the call site because it follows
from how the agent was told to think: an explorer asked for two to four tasks
wants three of them in flight, and saying so once beats saying it everywhere it
is used. A count that is not a positive whole number is ignored, since
`concurrency: 0` would mean an agent that delegates to nobody. See [Design decisions](../decisions.md); `agents/explorer.md`
is the one shipped agent that asks for it.

The allowlist covers these exactly as it covers pi's own, which is what keeps
the rule readable: what an agent can do is in its file. Naming `verdict` in an
agent nobody offers it to costs nothing, and the tool is simply absent.

## Skills

An agent can name skills, and only the ones it names:

```markdown
---
name: scout
description: Locates the code relevant to a question
tools: read, grep, find, ls
skills: diffing, humanising
---
```

A name is looked up in three places, **nearest first**:

1. `agents/scout/skills/` - beside the definition. `agents/scout.md` and the
   skills it needs travel together, so a clone of the repository resolves the
   same names.
2. `.pi/skills/` in the repository, found by walking up from the working
   directory.
3. `~/.pi/agent/skills/` - yours.

The first two are how a skill stays reproducible; the third is a convenience
that depends on the machine. A skill an agent cannot work without belongs in
the first.

Nothing is loaded eagerly: pi puts a name, a description and a path in the
system prompt, and the model opens `SKILL.md` itself. That last part is why an
agent declaring a skill **needs `read`** in its `tools:` - without it pi drops
the whole section - and why a skill whose frontmatter sets
`disable-model-invocation` is refused, since pi keeps that one out of the prompt
and the agent would never see it. Both fail at spawn, as does a name that
matches nothing, and the error names the three directories it looked in.

## What a subagent inherits

Nothing from your environment. The system prompt goes through the library's own
resource loader: no extensions, no context files, no project trust, and no skill
the definition did not name. A subagent sees what its own file asks for, which
is what makes a run reproducible.

Two lines are appended to it, and neither is inherited context. The first is
**where it is**: the ground every tool call stands on, without which a model
guesses. A real run showed the cost - a scout called `ls /Users/loic/gouarin/…`,
the user's name with a dot turned into a slash, got "no such path" and gave up
without ever trying a relative one.

The second is **which language to answer in**: the one the work is written in,
not the one these instructions are. Definitions here are English, so a French
question used to come back in English, translated by nobody's decision. The rule
points at the material rather than at the prompt around it, which is what makes
it hold when a workflow wraps a French request in English scaffolding - a review,
a plan, an audit - and it names no language itself, because an example in a
standing instruction is read as the target. Measured on a small open-weight
model: an English task answers English and a French one answers French;
`/step scout` and the whole `explore` pipeline answer in French, and a reviewer
handed a French goal answers in French while the router still answers an agent
name and the planner still answers JSON.

**The same rule closes every turn**, in one sentence, because the English a
subagent reads is not only in its prompt. A combinator frames the work - which
round this is, what is new on the board, what is still free to take - and that
framing arrives in the same message as the task, which weighs far more than
anything standing behind it. Measured on `ilaas/gpt-oss-120b`, a French question
put to a swarm of two over two rounds, counting the board posts that came back
in French: 5 of 19 with the standing rule alone, 62 of 89 with the closing line
as well. `ask()` adds it, so no combinator has to remember to, and what the
event stream reports stays the task the caller wrote.

What a word must not do is move. A model writing French writes `PRÊT` for
`READY` and `RAS` for `LGTM`, which is a loop that never ends and a review nobody
can parse. The instruction exempts by shape rather than by list - a word you were
told to answer with, a JSON key, a name, an identifier, a path, anything quoted
from code - so it also covers the sentinels of a workflow you write yourself.

## The model: yours to pin, not ours

An agent that declares no `model:` runs on whatever the caller passed, and on
pi's own settings when nobody passed anything. **None of the agents shipped here
declares one**, on purpose: a package that pinned a model would override the
settings you already made and fail outright if you hold no key for that provider.

The cost of that is invisible unless it is said out loud: a run with no `--model`
runs on your `~/.pi/agent/settings.json`, whatever is in it that day. Fine for
using the thing; useless for measuring it. So **anything whose numbers will be
compared names its model** - `experiment({ models })`, `--model` on `/run` and
`/build`, `--model` in the examples' argv. An agent you write for your own
machine is welcome to declare one; it is only what ships that must not.

## Agents shipped here

`agents/` holds the demo definitions used by the examples and by `/build`:
`scout`, `coder`, `reviewer`, `planner`, `router`, `synthesiser`, `interviewer`,
`auditor`, `committer`, `explorer`, `member`. They are symlinked into `.pi/agents/` so the extension
can find them - with an explicit scope, like anyone else's. None of them pins a
model, for the reason above.

## Reference

- [`agent`](../reference/api/agent.md) - `Agent`, `loadAgents`, `findAgent`, `parseAgent`.
- [`skills`](../reference/api/skills.md) - `resolveSkills`, `skillDirs`.
- [`language`](../reference/api/language.md) - `answerInTheirLanguage`, the standing instruction.
