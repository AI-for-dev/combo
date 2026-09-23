---
name: build-attended
description: Interview the user, confirm, build, then commit on the run's branch
input: string

nodes:
  - id: spec
    flow: interview
    input: input

  - id: go
    ask: "Build this?"
    confirm: true
    default: true
    reads: [spec]

  - id: gate
    choice:
      - when: go.output.yes
        do:
          - id: work
            flow: build
            input: spec

          - id: message
            agent: committer
            reads: [spec, diff]

          - id: commit
            commit: message
    default: []
---

## message
Write the commit message for the specification under `spec` and the change
under `diff`.
