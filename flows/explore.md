---
name: explore
description: Three scouts read the code in parallel, then one agent answers from what they found
input: string

nodes:
  - id: look
    map:
      - Find where the thing asked about is implemented, and name the files.
      - Find how it is tested, and what the tests actually assert.
      - Find what documents it, and whether that matches the code.
    concurrency: 3
    do:
      - id: find
        agent: scout
        retry: 1
        reads: [input, item]
        on-fail: continue

  - id: answer
    agent: synthesiser
    retry: 1
    reads: [input, look]
---

## find
Do the task under `item` about the question under `input`. Report what you
found with file paths and line numbers, and say plainly when you found nothing:
an empty report is worth more than a guess.

## answer
Answer the question under `input` from the three reports under `look`. Where
they are all silent, say so.
