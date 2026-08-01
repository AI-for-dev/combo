# Deliver a change

The combinators compose into one flow, driven from pi by `/build`. What runs
between the two stops is a [pipeline](pipelines.md) - a Markdown file you can
replace with your own, without touching any code:

```
/build add a cache in front of the agent loader

  interview   one question at a time, until you submit   -> a brief
  plan        who does what, validated before anything spawns
  pair        a worker and a reviewer per subtask, until accepted
  check       your own command runs; its verdict is final
  audit       one agent reads the whole, names what still has to change
  commit      an agent writes the message, this code makes the commit
```

It stops exactly **twice**: the brief, before any work starts, and the commit,
before anything reaches history. Refusing at either stop leaves everything where
it is - the brief in the editor, the work in the working tree. Nothing is undone
on your behalf.

## The interview

```typescript
const { brief, answers } = await interview({ agent: interviewer, input: request, ask });
```

`ask` is a port: a select card in pi, `readline` in an example, a scripted array
in the tests, which is how a conversation with a human is replayed offline.

One question at a time, because a good second question depends on the first
answer. Returning `undefined` from `ask` is the **submit**, not a cancel: what
was already answered still counts, and the brief is still written. `esc` maps to
it for the same reason.

The interviewer's lifetime defaults to `"workflow"`. An interview *is* a
conversation, and a `"task"` interviewer would forget the answer it just received
and ask around it forever.

## The delivery

From a script, without the interview:

```typescript
import { commandVerifier, deliver } from "combo";

const built = await deliver({
	planner,
	workers: [coder],
	reviewer,
	auditor,
	brief,
	verify: commandVerifier({ cwd, command: "npm", args: ["test"] }),
});
built.approved;   // the auditor signed off AND the check passed
```

Defaults worth knowing: `concurrency` is **2**, not 4, because these workers
write to the same working tree; `maxRounds` inside a pair is 3; audit cycles
default to 2; `maxTasks` defaults to 8.

## Reading code is not running it

`verify` is not a precaution. Without it, a pair once wrote a helper and its
tests, the reviewer approved, the auditor approved, and the test file imported
`./slugify.js` for a file named `slugify.ts`. The suite never even loaded. Both
agents had read the code.

**When a check is configured, its verdict is final.** No approval turns a failing
check into a success.

```typescript
commandVerifier({ cwd, command: "npm", args: ["test"] });
```

The command runs through `execFile` with **no shell**: arguments are a list, so
`"npm test && rm -rf /"` is an argument, not two commands. Its output is
evidence the agents read and cannot argue with. The **tail** is kept rather than
the head, because a test runner says what failed at the end.

## The commit

The committer agent has **no `bash`**. It reads the brief and the diff, and it
writes a message. The branch and the commit are made by `src/git.ts`, which has
no `push`, no `reset`, no `rebase`, no `--force`, and no shell. The commit
message is piped to `git commit -F -`, so a message containing `rm -rf /` is
committed rather than executed.

This was the obvious design to get wrong: give the agent git and tell it what not
to do. A prompt is not a permission boundary. Adding a subcommand is a decision
someone takes in a diff, not an argument a model produces at runtime.

## Carrying on after an interruption

Every step is written to `runs/<timestamp>/build.json`, so a Ctrl+C, a dropped
connection or a closed terminal costs nothing that was already paid for.

```
/build resume
> Carry on? 2/3 subtask(s) already approved
```

What survives, and why:

- **Only approved subtasks.** One still being argued over left the tree in a
  state nobody signed off on, so it runs again. Approval is the only claim from
  a previous life worth trusting.
- **The plan is reused, never re-made.** Re-planning would re-split work that is
  already half done on disk, and the plan was paid for.
- **Nothing of the conversation.** Agents are stored by name and resolved again;
  the messages are dropped. A resumed build re-reads the code rather than
  replaying a transcript, which is also what keeps the file small enough to write
  after every step.
- **A state whose agents no longer exist is refused whole.** Dropping the steps
  that no longer resolve would silently drop work.
- **The audit rounds already spent stay spent.** Resuming continues the cycle, it
  does not restart it.

## Choosing the pipeline

`/build` runs the pipeline named `build` if you have written one, in
`~/.pi/agent/pipelines/` or in `.pi/pipelines/`, and a built-in default
otherwise - the flow described above, expressed as data. Another one by name:

```
/build --pipeline audit check what the parser does with an empty file
```

A `build.md` that does not parse is **refused**, never silently replaced by the
default: a file sitting right there and quietly not being used is worse than an
error. `/pipelines` lists what is loaded and what does not parse.

For a pipeline that only reads, use `/run` instead: no interview, no commit stop.
See [Pipelines](pipelines.md).

## Why these are commands, not tools

A question card owns the terminal until it is answered, and nobody can answer a
question asked inside a model's turn. `/interview` and `/build` are therefore
registered as commands.

## Reference

- [`workflows/interview`](api/workflows/interview.md), [`workflows/pair`](api/workflows/pair.md), [`workflows/deliver`](api/workflows/deliver.md)
- [`ask`](api/ask.md) - `AskUser`, `Question`, `Answer`, `scriptedAsk`.
- [`verify`](api/verify.md) - `Verify`, `commandVerifier`.
- [`git`](api/git.md) - the git a pipeline may do.
- [`resume`](api/resume.md) - `build.json`, what survives and what deliberately does not.
