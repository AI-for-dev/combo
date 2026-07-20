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
| `model` | no | A pattern such as `anthropic/claude-sonnet-5`. Absent means pi's default. |
| `lifetime` | no | Default [lifetime](lifetime.md). An explicit argument always wins. |
| `openInHerdr` | no | Default for "give this agent its own herdr split". See [Display](display.md). |

A file missing `name` or `description` is **ignored silently**. That is pi's
behaviour and it is kept.

`description` is not decoration. A vague one produces vague routing, and no
parser can repair that.

## Where they are loaded from

```typescript
import { findAgent, loadAgents } from "pi-subagent";

const agents = loadAgents();                       // ~/.pi/agent/agents/ only
const both = loadAgents({ scope: "both" });        // plus .pi/agents/
const reviewer = findAgent(agents, "reviewer");    // throws on an unknown name
```

- `"user"` (the default) reads `~/.pi/agent/agents/`.
- `"project"` reads `.pi/agents/` of the current repository.
- `"both"` reads the two, and a project agent shadows a user agent of the same name.

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

## What a subagent inherits

Nothing from your environment. The system prompt goes through the library's own
resource loader: no extensions, no skills, no context files, no project trust.
A subagent sees its own definition and its `cwd`, which is what makes a run
reproducible.

## Agents shipped here

`agents/` holds the demo definitions used by the examples and by `/build`:
`scout`, `coder`, `reviewer`, `planner`, `router`, `synthesiser`, `interviewer`,
`auditor`, `committer`. They are symlinked into `.pi/agents/` so the extension
can find them - with an explicit scope, like anyone else's.

## Reference

- [`agent`](api/agent.md) - `Agent`, `loadAgents`, `findAgent`, `parseAgent`.
