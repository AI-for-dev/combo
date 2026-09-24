# Cheatsheet

Everything on one page, for lookup. Each section links to the page that explains it.

## Install and load

| Command | What it does |
| --- | --- |
| `npm install @ai-for-dev/combo` | the library, for your own scripts (Node 23.6 or later, no build step) |
| `pi install npm:@ai-for-dev/combo` | the extension, its agents and its flows, loaded into every pi session |
| `pi -e extension` | the same from a clone, for this session only |
| `npm test` | the offline suite, from a clone |

See [Quickstart](../guide/quickstart.md) and [Extension](../guide/extension.md).

## Commands in pi

| Command | What it does |
| --- | --- |
| `/run <flow> <input>` | runs a flow in `runs/<timestamp>/`, then puts its answer in the conversation |
| `/run resume [<run directory>]` | carries on the newest run here that can go on, or the one named |
| `/run` | lists the flows, as `/flows` does |
| `/flows` | lists the flows: source, worst case in turns and time, description, refused files |
| `/flows <name>` | prints one flow's plan, node by node; spawns nothing |
| `/agents` | lists the agents, grouped by where they come from |
| `/step <flow\|agent> <instruction>` | runs one stage on the previous step's output, kept out of the session |
| `/chain`, `/chain reset` | lists the steps walked so far, or starts a new chain |
| `/quote [<id>]` | puts one step into the conversation, the last one by default |
| `/swarm <goal>` | several copies of one agent on one job, with a board between them |
| `/interview <request>` | turns a vague request into a brief, one question at a time |
| `/stop [<id>\|all]` | stops the selected subagent, the one named, or the whole run |
| `/herdr [on\|off]` | gives every subagent its own herdr split; alone, says where it stands |

### Flags

Flags come before the text, in any order, written `--name value` or `--name=value`. A
value with spaces goes in double quotes. A line may end on `\` and go on below. `/run`
also reads its two flags at the end of the line.

| Command | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `/run` | `--model <pattern>` | none | the model of every agent turn; refused on a resume |
| `/run` | `--timeout <duration>` | none | the bound of one agent turn: `90s`, `10m`, `1h` |
| `/step` | `--from <id\|last\|none>` | `last` | which step's output is carried in |
| `/step` | `--model <pattern>` | none | the model of the stage |
| `/step` | `--agent` | off | run the agent of that name when a flow has it too |
| `/swarm` | `--members <n>` | `3` | how many copies |
| `/swarm` | `--agent <name>` | `member` | the agent copied |
| `/swarm` | `--rounds <n>` | `3` | the most rounds |
| `/swarm` | `--claim a,b,c` | none | things leased one owner at a time; done when each is reported on |
| `/swarm` | `--hold <n>` | none | the most claims one member may hold |
| `/swarm` | `--until agree` | off | done when every member votes the same way |
| `/swarm` | `--model <pattern>` | none | the model of every member |
| `/interview` | `--model <pattern>` | none | the interviewer's model |
| `/interview` | `--questions <n>` | `6` | the most questions asked |

### Keys during a run

| Key | What it does |
| --- | --- |
| `esc` | stops every subagent of the run |
| `ctrl+↑` / `ctrl+↓` | selects one subagent in the list above the prompt |
| `ctrl+del` | stops the selected one |

See [Extension](../guide/extension.md#the-commands), [Walk a chain by
hand](../guide/chain-by-hand.md), [Swarms](../guide/swarm.md) and
[Display](../guide/display.md).

## The `subagent` tool

The model calls it; you ask for it in plain words.

```text
> use subagent to review src/usage.ts with coder then reviewer, looping until LGTM
> use subagent with scope "project" and agent "scout" to find the auth code
> use subagent to run the interview flow on "add a --verbose flag"
```

With no `mode`, the fields given pick it, in this order: `flow`, then `candidates`
(route), `reduceWith`, `until` or `maxIterations` (loop), `steps` (chain), `tasks`
(parallel), else single. `orchestrate` is never inferred: it needs `mode`.

| Param | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | all | inferred | `single`, `chain`, `parallel`, `loop`, `route`, `orchestrate`, `reduce`, `flow` |
| `agent` | single, parallel, reduce; the router or planner | | agent name |
| `task` | all | | the task; the input of a flow |
| `tasks` | parallel, reduce | | independent tasks |
| `steps` | chain, loop | | agent names, in order |
| `candidates` | route, orchestrate | | agents the router or planner may pick |
| `reduceWith` | reduce, orchestrate | | agent that merges the results into one answer |
| `until` | loop | | a word alone on a line that ends the loop: `LGTM`, `APPROVED` |
| `maxIterations` | loop | `5` | loop cap |
| `maxTasks` | orchestrate | `8` | most subtasks a plan may hold |
| `concurrency` | parallel, reduce, orchestrate | `4` | branches at once |
| `lifetime` | all | `task` | `task`, `workflow` or `session` |
| `flow` | flow | | a flow name; takes only `task`, `model`, `timeoutMs`, `scope`, `herdrAll` |
| `model` | all | | one model for every subagent of the call |
| `timeoutMs` | all | none | deadline per turn |
| `scope` | all | `user` | agents from `user`, `project` or `both`; the shipped ones always |
| `maxDepth` | all | `2` | how deep a subagent may delegate |
| `openInHerdr` | all | | a herdr split per subagent |
| `herdrAll` | all | | a split for every subagent, not only those that ask |
| `export` | all | | transcripts and `usage.json` into `runs/<timestamp>/` |

See [Extension](../guide/extension.md#the-tool).

## An agent

A Markdown file: frontmatter, then the system prompt.

```markdown
---
name: tester
description: Runs the project's tests and says what failed
tools: read, grep, find, ls, bash
model: anthropic/claude-sonnet-5
lifetime: workflow
openInHerdr: true
---

Run the tests. Report each failure as file:line and one sentence.
```

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | required | how every caller names it; a file without one is ignored |
| `description` | required | one line; `route` and `orchestrate` choose by it |
| `tools` | `read, grep, find, ls` | the allowlist, a YAML list or one comma-separated line |
| `skills` | none | skills it may load, by name; needs `read` in `tools` |
| `model` | pi's settings | a model pattern |
| `lifetime` | `task` | what `spawn` uses when the call names none; a workflow passes its own |
| `concurrency` | | children at once, for an agent whose `tools` names `subagent` |
| `openInHerdr` | | a herdr split for it by default |

Three tools are combo's, not pi's: `subagent` (delegate to children), `board` (a swarm's
board) and `verdict`, which a flow node adds itself and a definition never names.

| Where | Source | Loaded |
| --- | --- | --- |
| `agents/` in the package | `builtin` | by the extension always; by the library with `builtin: true` |
| `~/.pi/agent/agents/` | `user` | by default |
| `.pi/agents/` in the repository | `project` | with scope `project` or `both`; `/run` and `/step` always |

The later row wins a name. A skill is looked up in `agents/<name>/skills/`, then
`.pi/skills/`, then `~/.pi/agent/skills/`. See [Agents](../guide/agents.md).

## A flow

YAML for the structure, one `## <id>` section per `agent` node for the prose. Saved as
`.pi/flows/fix.md`:

```markdown
---
name: fix
description: Plan a change, code and review each task, test, then commit if asked
input: string
timeout: 10m
nodes:
  - id: plan
    agent: planner
    reads: [input]
    output: { tasks: [{ text: string }] }
    retry: 1
  - id: work
    map-from: plan.output.tasks
    max: 4
    do:
      - id: pair
        loop: review.output.approved
        max: 3
        ledger: pair
        on-fail: continue
        do:
          - id: code
            agent: coder
            memory: pair
            reads: [item.text, pair.ledger]
          - id: review
            agent: reviewer
            memory: pair
            verdict: pair
            reads: [item.text, diff]
  - id: tests
    check: .pi/checks/test.sh
    timeout: 5m
  - id: go
    ask: "Commit this?"
    confirm: true
    default: false
    reads: [tests.output.report]
  - id: gate
    choice:
      - when: tests.output.passed && go.output.yes
        do:
          - id: message
            agent: committer
            reads: [input, diff]
          - id: commit
            commit: message
    default: []
---

## plan
Split the request into tasks a coder can do one at a time.

## code
Do the task under `item.text`, and close what `pair.ledger` still holds.

## review
Review the change under `diff` against the task.

## message
Write the commit message for the change under `diff`.
```

### The file

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | yes | the file name without `.md`; `resume` is taken |
| `description` | yes | one line |
| `input` | yes | `string`, or a schema |
| `model` | no | the model of every agent turn, and of callees that set none |
| `timeout` | no | the bound of one agent turn, here and in callees that set none |
| `nodes` | yes | the root sequence, run in order |

Flows are found like agents: the package's `flows/`, then `~/.pi/agent/flows/`, then
`.pi/flows/`, the later one winning a name.

### Nodes

A node is `id:` plus exactly one kind key. A `-from` key takes an address where its twin
takes a literal.

| Kind key | Runs | Output | Other keys |
| --- | --- | --- | --- |
| `agent`, `agent-from` + `among` | one agent turn | its text, or the `output:` value | `reads`, `output`, `memory`, `verdict`, `retry`, `timeout` |
| `choice` | the first case whose `when` holds | `{ case, output? }` | `default` (required, `[]` for nothing) |
| `parallel` | named branches at once | `{ <branch>: ... }` | `copies`, `fail-fast` |
| `map`, `map-from` | `do:` once per item, `item` inside | `[{ item, ok, output?, error? }]` | `max` (required with `map-from`), `concurrency` (`1`), `copies`, `fail-fast`, `ledger` |
| `loop` | `do:` until its condition holds | `{ converged, stop, iterations, last }` | `max` (required), `give-up`, `carry`, `ledger` |
| `check` | a project script, with `bash` | `{ passed, report }` | `timeout` (`120s`) |
| `commit` | commits the tree on `combo/<slug>` | `{ committed, sha?, branch }` | none |
| `ask`, `ask-from` | a question card | by form, below | `options`, `confirm`, `enough`, `default`, `reads`, `timeout` |
| `flow` | another flow, whole | the callee's last root node | `input` (required, an address) |

Every kind takes `on-fail: continue`: a failure stops at that node, and later nodes read
`x.ok` and `x.error`. `retry:` is on `agent` nodes only.

| Key | Meaning |
| --- | --- |
| `reads: [a, b]` | addresses handed to the turn, in order, each under `## <address>` |
| `output: <schema>` | the turn answers through a `submit` tool built from the schema |
| `memory: <id>` or `flow` | nodes naming the same agent and scope resume one subagent |
| `verdict: <id>` | the turn decides with the `verdict` tool, into that node's `ledger` |
| `retry: n` | `n` more attempts after a `provider`, `timeout` or `schema` failure |
| `timeout: 10m` | the bound of one attempt, or of a check or a card |
| `copies: true` | each branch works in its own copy of the repository |
| `carry: { first, next }` | what `<loop>.carry` reads, first and after each iteration |

| `ask` written with | Form | Output |
| --- | --- | --- |
| `options: [...]` (2 to 4), or `ask-from:` | a choice | `{ answered, answer?, custom? }` |
| `confirm: true` | yes or no | `{ yes }` |
| neither | free text | a `string` |

### Addresses, schemas, conditions

| Address | What it is |
| --- | --- |
| `plan` | the node's output: text, or a typed value |
| `plan.ok`, `plan.error.kind` | whether it ran, and why not |
| `plan.output.tasks` | a field of a typed output |
| `input`, `item`, `diff` | the run's input, the `map` item, the tree's change since `HEAD` |
| `<loop>.previous.<node>`, `<loop>.carry`, `<id>.ledger` | inside a loop or ledger |

| Schema | Type |
| --- | --- |
| `string`, `number`, `boolean` | a scalar |
| `scout \| reviewer` | an enum |
| `[<schema>]` | a list |
| `{ task: string, note?: string }` | an object, `?` for optional |
| `Question` | what an `ask-from:` card draws |

A condition (`loop:`, `when:`, `give-up:`) is a subset of CEL: literals, addresses,
`== != < <= > >=`, `&& || !`, `in`, `size()`, `has()`, `all`, `exists`. No arithmetic.
Guard a read that may fail: `audit.ok && audit.output.approved`.

See [Flows](../guide/flows.md) for every key, the run directory and the faults, and
[From pipelines to flows](../guide/from-pipelines.md) for a pipeline of your own.

## The library

One agent, one task:

```typescript
import { findAgent, loadAgents, run } from "@ai-for-dev/combo";

const agents = loadAgents({ scope: "both", builtin: true });
const scout = findAgent(agents, "scout");

const result = await run(scout, "Find the authentication code", { timeoutMs: 120_000 });
result.ok;      // false on a model failure, never a throw
result.output;  // the last assistant text
result.usage;   // turns, tokens, cost, time
```

A subagent that remembers:

```typescript
const coder = await spawn(findAgent(agents, "coder"), { lifetime: "workflow" });
try {
	await coder.ask("Implement the parser");
	await coder.ask("Apply the review remarks"); // it remembers the first turn
} finally {
	await coder.close(); // whoever opens, closes
}
```

### Combinators

| Call | Shape |
| --- | --- |
| `chain({ steps: [scout, reviewer], input })` | each output is the next input |
| `fanOut({ agent: scout, tasks, concurrency: 2 })` | N tasks at once, results in task order |
| `loop({ steps: [coder, reviewer], input, until })` | again until `until`, `maxIterations` 5 |
| `reduce({ agent: synthesiser, results, input })` | N results into one answer |
| `route({ router, destinations: [coder, scout], input })` | a classifier picks who does it |
| `orchestrate({ planner, workers, input, reduceWith })` | a planner splits the work, `maxTasks` 8 |
| `interview({ agent: interviewer, input, ask })` | questions for the user, then a brief |
| `swarm({ members: [{ agent: member, count: 3 }], goal })` | members share a board, 3 rounds |

Each also takes `lifetime`, `signal`, `timeoutMs`, `model`, `openInHerdr`, `onEvent`,
`bus`, `cwd`, `sessionDir`, `exportDir` and `spawn`. `timeoutMs` has no default. See
[Workflows](../guide/workflows.md) and [Lifetime](../guide/lifetime.md).

### Flows from code

```typescript
import { bashCheck, checkFlow, checkRun, createRunDir, gitPort,
	loadFlowCatalogue, measuredRun, resumeFlow, runFlow } from "@ai-for-dev/combo";

const catalogue = loadFlowCatalogue({ cwd, scope: "both", builtin: true });
const flow = checkFlow("build", catalogue); // the file, its callees, its agents
if (!flow.ok) throw new Error(flow.faults.map((fault) => fault.message).join("\n"));

const ports = { check: bashCheck(), git: gitPort() };
// the run stage: the tree, the scripts, git, whether somebody is there
const launch = await checkRun(flow.flow, { cwd, ports, somebodyThere: false });
if (!launch.ok) throw new Error(launch.faults.map((fault) => fault.message).join("\n"));

const runDir = createRunDir(); // runs/<timestamp>/
const measured = measuredRun({ dir: runDir });
const done = await runFlow(launch.run, "add a cache", {
	runDir,
	onEvent: measured.onEvent,
});
measured.finish(); // writes usage.json

if (!done.ok) await resumeFlow(runDir, { ports, somebodyThere: false });
```

A dry run answers every turn from a script and touches nothing:

```typescript
const explore = checkFlow("explore", loadFlowCatalogue({ builtin: true }));
if (!explore.ok) throw new Error("explore does not check");

const dry = await dryRunFlow(explore.flow, "where is usage measured?", {
	"look/find": "src/usage.ts",
	answer: "In src/usage.ts.",
});
dry.ok; // true, with zero tokens spent
```

### Experiments and stopping

```typescript
const report = await experiment({
	models: ["anthropic/claude-sonnet-5", "local/qwen/qwen3-coder-next"],
	repetitions: 3,
	run: async (cell) => {
		const steps = [coder, reviewer];
		const result = await loop({ ...cell.options, steps, input, until });
		return { ok: result.ok, converged: result.converged };
	},
});

const stop = stopSwitch(); // pass stop.signal and stop.spawn to a workflow or runFlow
stop.one("scout#2");       // one subagent
stop.all();                // the whole run
```

See [Experiments](../guide/experiments.md) and the [API reference](api/index.md).

## The model and the deadline

The nearest setting wins. No environment variable is read.

| Model, nearest first | Set with |
| --- | --- |
| the call | `model` on `spawn`, `run`, a workflow, `runFlow`; the tool's `model`; `--model` on `/run`, `/step`, `/swarm`, `/interview` |
| the flow | its `model:`, then the `model:` of each flow calling it |
| the agent | its frontmatter `model:` |
| pi | `~/.pi/agent/settings.json` |

| Deadline of one agent turn in a flow, nearest first | Set with |
| --- | --- |
| the run | `timeoutMs` on `runFlow`, `--timeout` on `/run` |
| the node | its `timeout:` |
| the flow | its `timeout:`, then that of each flow calling it |
| the default | 30 minutes |

A `check` takes its own `timeout:` or two minutes, and an `ask` card only its own
`timeout:`. Outside a flow, `timeoutMs` has no default. `/interview` gives each turn five
minutes.

## On disk

| Path | Written by | Holds |
| --- | --- | --- |
| `runs/<timestamp>/` | `/run`, `/step`, `export: true`, `createRunDir()` | one run; `runs/.gitignore` holds `*` |
| `snapshot.json` | a flow run | the flow and its callees, agents, check scripts, input, settings: what a resume runs |
| `journal.jsonl` | a flow run | one fact per line, appended; what a resume reads |
| `lock.json` | a flow run, while it runs | the pid and host of its runner |
| `<home>/<agent>.jsonl`, `.html` | each subagent, as it closes | its transcript, under its memory scope or visit path |
| `<parent>.children/` | a delegating subagent | its children's transcripts |
| `agents/<agent>/skills/` | a flow run | copies of the skills its agents declare |
| `.sessions/` | any export | the pi sessions behind the transcripts |
| `main.jsonl` | the extension | the parent pi session |
| `usage.json` | `measuredRun` | time and tokens per subagent; a flow run adds `visits`, `nodes`, `lives` |
| `events.jsonl` | `measuredRun({ record: true })`, each experiment cell | the event stream |
| `1-explore/`, `2-planner/` | `/step`, `/swarm` | one folder per step of a chain |
| `experiment.json`, `experiment.md`, `<model>/rep-<n>/` | `experiment()` | the table, and one directory per cell |

See [Export](../guide/export.md), [The run directory](../guide/flows.md#the-run-directory)
and [Measurements](../guide/measurements.md).

## Shipped agents

| Agent | Tools beyond `read, grep, find, ls` | Lifetime | What it does |
| --- | --- | --- | --- |
| `scout` | | `task` | locates the code relevant to a question and reports where it lives |
| `explorer` | `subagent` | `task` | answers by splitting the reading across scouts, three at once |
| `planner` | | `task` | splits work into independent subtasks and assigns each one |
| `router` | | `task` | picks which agent should handle a task |
| `coder` | `edit`, `write` | `workflow` | implements a change, and applies review remarks across iterations |
| `reviewer` | | `workflow` | reviews code and returns at most five actionable remarks, or `LGTM` |
| `auditor` | | `task` | reads the finished work as a whole, says what still has to change, or `APPROVED` |
| `synthesiser` | | `task` | merges the findings of several subagents into one answer |
| `interviewer` | | `workflow` | turns a vague request into a specification, one question at a time |
| `committer` | | `task` | writes the commit message for finished work |
| `member` | `board` | `workflow` | works one job beside other members of a swarm |

None names a `model:`. A file of the same name in `~/.pi/agent/agents/` or `.pi/agents/`
replaces one.

## Shipped flows

The worst case is what `/flows` prints.

| Flow | Worst case | What it does |
| --- | --- | --- |
| [`explore`](flows/explore.md) | 8 turns, 2h | three scouts read the code in parallel, then one agent answers |
| [`split`](flows/split.md) | 12 turns, 4h | a planner splits a read-only question between a scout and a reviewer, then one answer |
| [`interview`](flows/interview.md) | 14 turns, 7h and a person's answers | asks one question at a time, then writes a specification |
| [`build`](flows/build.md) | 154 turns, 41h20m | locates, splits, codes in reviewed pairs, runs `.pi/checks/test.sh`, audits; commits nothing |
| [`build-attended`](flows/build-attended.md) | 170 turns, 49h20m and a person's answers | interviews, asks "Build this?", builds, commits on the run's branch |

Every agent node of these flows has `retry: 1`. See [Deliver a
change](../guide/build.md).
