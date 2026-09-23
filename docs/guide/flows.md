# Flows

```{note}
The flow format ships in a coming release. Nothing in the package exports it
yet: until then, [pipelines](pipelines.md) are what `/build` and `/run` read.
```

A flow is a task graph you write in YAML and Markdown, next to your agents. It is
built from a closed set of nodes, checked whole before its first spawn, and
walked by our code. No agent reads the file to decide what runs next: a model
produces values, and the runner reads them.

```markdown
---
name: split
description: A planner splits a question, one agent takes it, another answers
input: string
nodes:
  - id: plan
    agent: planner
    reads: [input]
    output: { first: scout | reviewer, task: string }
  - id: first
    agent-from: plan.output.first
    among: [scout, reviewer]
    reads: [plan.output.task]
  - id: answer
    agent: synthesiser
    reads: [input, first]
---

## plan
Split the request below.

## first
Do the task below.

## answer
Answer the request from the report below.
```

## The file

The frontmatter holds the structure, the body holds the prose.

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | yes | the flow's name, the same as its file name without `.md` |
| `description` | yes | one line |
| `input` | yes | `string`, or a [schema](#schemas) for a typed input |
| `model` | no | the model of every agent turn, unless a command says otherwise |
| `timeout` | no | the default bound of one agent turn: `90s`, `10m`, `1h` |
| `nodes` | yes | the root sequence |

A flow is a sequence of nodes, run one after the other. No node names a
successor, so a jump or a dangling edge cannot be written.

The body holds one `## <id>` section per `agent` node and nothing else. `###`
headings inside a section are prose, and so is a `##` inside a fenced code
block. Text before the first section is refused: no turn would read it.
`description:` and YAML comments are where a flow is documented.

## Nodes

A node is `id:` plus exactly one kind key, which holds its main argument, and
that kind's options beside it. An id is letters, digits and `_`, unique in the
whole file, since addresses and conditions read it. It cannot be a word an
address uses (`input`, `item`, `diff`, `output`, `ok`, `error`, `previous`,
`carry`, `ledger`) or one CEL reserves (`in`, `loop`, `if`...).

A key ending in `-from` takes an [address](#reads-and-addresses) where its twin
takes a literal. Writing both on one node is refused, and so is any key the kind
does not have, a key valid on another kind included.

### `agent`

One turn of an agent from the catalogue.

| Key | Meaning |
| --- | --- |
| `agent` | the agent, by name |
| `agent-from` + `among` | an address naming an enum, and the agents it may pick, which are exactly its values |
| `reads` | the addresses handed to the turn, in order |
| `output` | a [schema](#schemas): the output is typed, instead of the agent's text |
| `memory` | `flow`: every node naming this agent and scope resumes the same subagent |
| `retry` | how many more attempts after a failed one, default 0 |
| `timeout` | the bound of one attempt, `90s`, `10m`, `1h` |
| `on-fail` | `continue`: a failure stops at this node instead of ending the flow |

## Reads and addresses

A node reads, by address, the nodes that already ended before it, and `input`.
A bare id is that node's output, whole. A deeper address reads a node as it
ended:

| Address | What it is |
| --- | --- |
| `plan` | the node's output: its text, or its typed value |
| `plan.ok` | whether the node ran |
| `plan.output.first` | a field of a typed output |
| `plan.error.kind` | why the node failed, one of a closed set of twelve |

An agent's text has no fields: it is read whole, never into. Every address is
checked before the first spawn.

## Schemas

A typed output, or a typed input, is declared in a short notation that is YAML
read as a type:

| Written | Type |
| --- | --- |
| `string`, `number`, `boolean` | the scalar |
| `scout \| reviewer` | an enum: one of these strings |
| `[<schema>]` | a list |
| `{ task: string, note?: string }` | an object; `?` marks an optional field |
| `Question` | the question an `ask` card draws |

When a field needs a description for the model that fills it, write
`{ json-schema: ... }` with `type`, `properties`, `required`, `items`, `enum` and
`description`, and nothing else. A field name is letters, digits and `_`.

## Conditions

A condition is a strict subset of [CEL](https://cel.dev) syntax, so every
condition is also valid CEL. It has literals, addresses, `== != < <= > >=`,
`&& || !`, `in` on a list, `size()`, `has()`, and the `all` and `exists` macros.
It has no arithmetic, no ternary and no string functions: a node that decides
declares an enum.

A condition reads typed values only, and is type-checked before the first spawn.
A string compared with an enum must be one of its values. A condition that cannot
be evaluated (a failed node, an absent optional field) fails its node rather than
reading as `false`; guard it the CEL way, `audit.ok && audit.output.approved`.

## Faults

A flow that does not pass is refused with every fault at once, in file order,
each as `{ code, file, at, message }`. `at` is the node's id, or the flow's key,
then the offending key: `first.agent-from`.

| Code | What it means | How to fix it |
| --- | --- | --- |
| `yaml-syntax` | the frontmatter is not valid YAML; the only fault returned | fix the YAML at the line given |
| `not-a-flow` | the file has no frontmatter mapping | start the file with `---` and the flow's keys |
| `name-mismatch` | `name:` differs from the file name | rename one of them |
| `unknown-flow` | no flow file has that name | use the name offered, or add the file |
| `missing-key` | a required key is absent | add it |
| `unknown-key` | a key this flow or this kind of node does not have | use the key offered, or remove it |
| `key-type` | a key holds a value of the wrong type | write the type the message names |
| `node-kind` | a node has no kind key, or more than one | keep exactly one |
| `twin-keys` | a key and its `-from` twin on one node | keep the literal or the address |
| `invalid-id` | an id is not letters, digits and `_` | rename it, `ask-next` as `ask_next` |
| `reserved-id` | an id is a word an address or CEL uses | rename it |
| `duplicate-id` | two nodes of the file share an id | rename one |
| `unknown-agent` | no agent of the catalogue has that name | use the name offered, or add the agent |
| `unknown-address` | an address names nothing readable here | read a node that already ended, or a field that exists |
| `invalid-address` | an address is not a name followed by fields, or reads into text | write `node.output.field`, and read an agent's text whole |
| `among-without-from` | `among:` beside `agent:` | use `agent-from:`, or drop `among:` |
| `among-mismatch` | `among:` does not name exactly the enum's values | make the two lists agree |
| `unknown-scope` | `memory:` names no enclosing node | name one, or `flow` |
| `section-missing` | an `agent` node has no `## <id>` section | write its section |
| `section-empty` | a section has no text | say what the turn is asked |
| `section-duplicate` | two sections share a heading | merge them |
| `section-unknown` | a section matches no node | rename it to the id offered, or remove it |
| `body-preamble` | text before the first section | move it to `description:` or a YAML comment |
| `schema-invalid` | a schema is outside both notations | write it as the message says |
| `condition-syntax` | a condition is not in the language | rewrite the part quoted |
| `condition-unknown-address` | a condition names nothing readable | read what the message lists |
| `condition-type` | a condition's parts do not fit together, or it is not a boolean | compare values of one type |
| `condition-enum-value` | a string compared with an enum is not one of its values | use one of the values listed |
