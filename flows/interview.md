---
name: interview
description: Ask the user one question at a time, then write a specification
input: string

nodes:
  - id: interview
    loop: "!has(ask_next.output.question) || !gate.output.output.answered"
    max: 6
    on-fail: continue
    do:
      - id: ask_next
        agent: interviewer
        memory: flow
        retry: 1
        reads: [input, interview.previous.gate]
        output: { question?: Question }

      - id: gate
        choice:
          - when: has(ask_next.output.question)
            do:
              - id: ask
                ask-from: ask_next.output.question
                enough: "That's enough, write the brief"
        default: []

  - id: brief
    agent: interviewer
    memory: flow
    retry: 1
    reads: [input]
---

## ask_next
Ask the user the next question about the request under `input`, or ask none
when you know enough to write the specification. You have six questions at
most in all.

When `interview.previous.gate` follows, it holds the user's answer to your last
question: `custom` is true when they wrote it themselves rather than picking an
option.

Keep a label under 30 characters and a description under 60: the card draws
them on one line, and what overflows is cut.

## brief
Write the specification for the request under `input` from everything the user
answered. It is the only thing the agents doing the work will read: they will
not see this conversation, and they cannot ask you anything.

Write it as the goal in one or two sentences, then what must be done, then what
is explicitly out of scope, then how anyone can tell it is finished. Answer with
the specification itself, as text: this turn calls no tool.
