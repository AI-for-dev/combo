# Two agents arguing until LGTM

![Two agents arguing until LGTM](../_static/tutorials/07-until-lgtm.svg)

An agent that reviews its own work approves it. Not always, and not out of
laziness: it wrote the code with a model of what the code does, and it reads
the code through the same model. The mistake it made is the mistake it cannot
see. The oldest answer is a second reader, and the shape is a loop: one
writes, one reads, and the loop ends when the reader has nothing left to say.

How it ends is where the questions are.

## Run it somewhere it may write

The coder holds `edit` and `write`. It will use them, so do this in a clone
you can throw away:

```bash
git clone combo /tmp/play && cd /tmp/play && pi -e extension
```

Then, as a sentence:

```
> use subagent with steps coder then reviewer, looping until LGTM with lifetime
  workflow, to add a two-line usage example to the TSDoc comment of saysWord in
  src/text.ts
```

The session read `src/text.ts` first, then made one call. Halfway through,
the coder had finished its turn and the reviewer was reading:

```
● coder#1  edit src/text.ts
  provider/model · ↑9.1k ↓1.7k · 17.3s
● reviewer#1  read src/text.ts
  provider/model · 43.6s
```

The coder's line has its tokens because its turn has ended, and pi's counters
are read when a turn ends; its dot stays on because `lifetime workflow` keeps
it alive for the next iteration. The reviewer is still in its first turn, so its line
gives only the model and the clock: a figure there would be one nobody
measured. The model on the line is the one the call put every subagent on. A
subagent never takes the session's model, so the one it runs on is whatever
the call says, or the agent's file, or pi's settings.

Then the row:

```
subagent loop coder → reviewer [workflow]
  Add a two-line usage example to the TSDoc comment of `saysWord` in `s…
✓ coder#1 Add a two-line usage example to the TSDoc comment…
    read src/text.ts
    edit src/text.ts
✓ reviewer#1 I added a two-line usage example to the TSDoc com…
    find src/text.ts
    read src/text.ts

2 turns 87.0s ↑14k ↓4.9k  1 iteration  converged
ctrl+o to expand
```

The header names the two steps the loop runs. The usage line has no cost in
it: this provider reports none, and a missing figure is left out rather than
printed as `$0.0000`, which would read as free.

And the text the model reads:

```
## coder

I added a two-line usage example to the TSDoc comment of `saysWord` in `src/text.ts`, showing a case where it returns `true` for a decorated word on its own line in a multi-line string, and `false` when the word is not alone on the line.

Changed files:
- `src/text.ts`

## reviewer

LGTM


(converged after 1 iteration)
```

The diff is real:

```diff
  * loop forever waiting for a verdict already given. Decoration is stripped, case
  * is ignored; a line with anything else on it still does not count.
+ *
+ * `saysWord("Hello\n**LGTM**", "LGTM")` is `true`.
+ * `saysWord("LGTM this", "LGTM")` is `false`.
  */
 export function saysWord(output: string, word: string): boolean {
```

The coder read the function's own comment and wrote two examples that are
correct, which on a small model is not a given.

One thing in the frame that was not asked for: after the tool returned, the
session wondered whether the coder "actually performed the edit or if it's
expecting me to", read the file, and concluded "The subagent did indeed add
the lines". That is the session doing the reviewer's job one level up, and it
is why the tool row lists the calls: `edit src/text.ts` is a fact, "I added"
is a claim.

## How it ends: the word

`until LGTM` is read by `saysWord`, the very function the coder just
documented, and the rule is **whole line**: the loop stops when the word
stands alone on one of the reviewer's lines, whatever decoration the model put
around it. `**LGTM**` counts. `LGTM.` counts. The line `LGTM this` does
not, which is the coder's second example, and neither does `I cannot say LGTM
yet`: that exact sentence is why the rule is not "contains", because a
substring match once ended a review on it.

The reviewer answered with the word alone, as its definition tells it to.
That word is the whole contract of a `loop`: nothing else in the reviewer's
turn is read. In a flow node written with
[`verdict:`](../guide/flows.md#ledgers-and-verdicts), the flow hands the
reviewer a `verdict` tool, and the call **is** the decision, with `approved` a
boolean and the prose beside it the argument. Prefer that when you write your
own reviewer: a word has to be recovered from prose written for a human, and a
tool call is a discrete event with a schema. "Did it decide" and "what did it
decide" become closed questions.

## How it ends: the cap

`maxIterations` defaults to 5, and hitting it is reported apart from success.
Ask for a word the reviewer was never told to say, and cap it at two:

```
> use subagent with steps coder then reviewer, looping until APPROVED with
  maxIterations 2 and lifetime workflow, to add a two-line usage example to
  the TSDoc comment of saysWord in src/text.ts
```

```
subagent loop coder → reviewer [workflow]
  Add a two-line usage example to the TSDoc comment of saysWord in src/…
✓ coder#1 LGTM
    read src/text.ts
    edit src/text.ts
✓ reviewer#1 Glad to hear it. I have completed the requested c…
    read src/text.ts

4 turns 98.4s ↑21k ↓8.5k  2 iterations  NOT converged
ctrl+o to expand
```

The reviewer approved the way its definition says, with `LGTM`. The coder was
handed that `LGTM` as its next task and answered "Glad to hear it. I have
completed the requested changes."; the reviewer, handed that, said `LGTM`
again. Every turn ran without a model error, so `ok` is true. `converged` is
false: nobody said the word the loop was waiting for. Collapsing those two
into one boolean would hide the only thing worth knowing, so a loop reports
both, and a flow's `loop` that reaches its `max:` **fails** with
`unconverged` rather than handing the next node work that nobody approved.

This time the session took the hint. It read the "did NOT converge" at the end
of the answer, worked out that the loop waited for `APPROVED` while the
reviewer said `LGTM`, read the file to check the edit was there, and reported
the example added, with the loop's `NOT converged` named as the reason. That
reading was the session's own; what the loop reports is only the two flags.

## Team, or fresh eyes

`lifetime workflow` in the call is why there is one coder and one reviewer
for the whole run, however many iterations it takes. The coder remembers the review it was given;
the reviewer remembers what it already asked for and does not ask again. That
is a team, and it converges fast. It also drifts: a reviewer that has approved
the shape of the code twice reads the third version through that approval.

Leave `lifetime` out and the default is `task`: brand new subagents at every
iteration. Every review starts from the code alone, with no memory of what it
said last time. More re-reading, more tokens, and a reviewer that cannot be
talked into anything because it was not there for the argument. Neither is
better. Say which one you meant, every time.

## What approval is worth

A reviewer's yes is not the end of the argument, only of the reviewer's part
in it. Measured on a small open-weight model, a reviewer holding the
`verdict` tool called it correctly and approved a function that computed
`a - b` while claiming to add. A clean channel does nothing about a wrong
judgement.

So in a flow, finished is a **ledger**. Every remark the reviewer raises
becomes an obligation with an id combo assigns; later rounds list the open ones
and ask the reviewer what became of each, by id; only the agent that raised one
can close it. `approved` then means two
things at once: the reviewer had nothing further to ask, and nothing it raised
is still open. A reviewer that says yes over an obligation it never closed has
not finished the work, and the result names the ids that are left.

Which leaves the question the row above cannot answer. The reviewer read the
file and said LGTM. Did anything run?

**Next:** [Reading code is not running it](08-build.md).
