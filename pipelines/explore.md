---
name: explore
description: Three scouts read the code in parallel, then one agent answers from what they found
steps:
  - id: look
    fanOut: scout
    tasks:
      - Find where the thing asked about is implemented, and name the files.
      - Find how it is tested, and what the tests actually assert.
      - Find what documents it, and whether that matches the code.
    concurrency: 3
    lifetime: task

  - id: answer
    reduce: synthesiser
    lifetime: task
---

## look

Read only. Report what you found with file paths and line numbers, and say
plainly when you found nothing - an empty branch is worth more than a guess.

## answer

Answer the question from the three reports below. Where they disagree, say so
rather than picking one; where they are all silent, say that too.
