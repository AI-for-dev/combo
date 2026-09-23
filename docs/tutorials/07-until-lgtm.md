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

The first call did not get far:

```
subagent loop coder [workflow] [anthropic/claude-3-7-sonnet]
  Add a two-line usage example to the TSDoc comment of the `saysWord` f…
✗ coder#1 Add a two-line usage example to the TSDoc comment… No API key found for anthropic. Use /lo…

1 turn 0.0s ↑0 ↓0 $0.0000  1 iteration  NOT converged
```

Nobody asked for that model. The session filled in the tool's `model`
argument with one it had heard of, and the call failed at once, before any
work, because there is no key for it here. The bracket on the first line is
the model the call put every subagent on, which is why it is drawn there: a
subagent never takes the session's model, so the one it runs on is whatever
the call says, or the agent's file, or pi's settings. The session read the
error and called again without it:

```
● coder#2  edit src/text.ts
  provider/model · ↑0 ↓0 · 63.7s
```

Then the reviewer, then the row:

```
subagent loop coder [workflow]
  Add a two-line usage example to the TSDoc comment of the `saysWord` f…
✓ coder#2 Add a two-line usage example to the TSDoc comment…
    read src/text.ts
    grep //\*\*/
    edit src/text.ts
✓ reviewer#1 I added a two-line usage example to the TSDoc com…
    read src/text.ts
    verdict verdict=LGTM

2 turns 119.2s ↑28k ↓5.8k $0.0000  1 iteration  converged
ctrl+o to expand
```

And the text the model reads:

````
## coder

I added a two-line usage example to the TSDoc comment of the `saysWord` function in `src/text.ts` to clarify its lenient matching behavior.

```typescript
/**
 * Whether `word` stands alone on one of the lines.
 …
 * `saysWord("**LGTM**", "LGTM")` is `true`.
 * `saysWord("This is LGTM", "LGTM")` is `false`.
 */
```

## reviewer

LGTM


(converged after 1 iteration)
````

The diff is real:

```diff
  * loop forever waiting for a verdict already given. Decoration is stripped, case
  * is ignored; a line with anything else on it still does not count.
+ *
+ * `saysWord("**LGTM**", "LGTM")` is `true`.
+ * `saysWord("This is LGTM", "LGTM")` is `false`.
  */
 export function saysWord(output: string, word: string): boolean {
```

The coder read the function's own comment and wrote two examples that are
correct, which on a small model is not a given.

One thing in the frame that was not asked for: after the tool returned, the
session tried to make the same edit itself, failed because the text was
already there, read the file, and concluded "Yes, the subagent did it." That
is the session doing the reviewer's job one level up, and it is why the tool
row lists the calls: `edit src/text.ts` is a fact, "I added" is a claim.

## How it ends: the word

`until LGTM` is read by `saysWord`, the very function the coder just
documented, and the rule is **whole line**: the loop stops when the word
stands alone on one of the reviewer's lines, whatever decoration the model put
around it. `**LGTM**` counts. `LGTM.` counts. The line `This is LGTM` does
not, which is the coder's second example, and neither does `I cannot say LGTM
yet`: that exact sentence is why the rule is not "contains", because a
substring match once ended a review on it.

The reviewer in the row also did something else: it called `verdict`, with an
argument of its own invention. Its definition names that tool and tells it to
call it when it is given one, but a `loop` hands over no such tool; pi
refuses a call to a tool the session does not hold, and the loop read the
word, as it always does. In a flow node written with
[`verdict:`](../guide/flows.md#ledgers-and-verdicts), the tool exists and the
call **is** the decision, with `approved` a boolean and the prose beside it
the argument. Prefer that when you write your own reviewer: a word has to be
recovered from prose written for a human, and a tool call is a discrete event
with a schema. "Did it decide" and "what did it decide" become closed
questions.

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
✓ reviewer#1 Glad it works for you.
    read src/text.ts
    verdict argument=The added TSDoc examples accu…
    verdict argument=The added TSDoc examples accu…

4 turns 81.6s ↑28k ↓6k $0.0000  2 iterations  NOT converged
ctrl+o to expand
```

The reviewer approved the way its definition says, with `LGTM`. The coder was
handed that `LGTM` as its next task and answered "Glad it works for you."; the
reviewer, handed that, answered "You're welcome." Every turn ran without a
model error, so `ok` is true. `converged` is false: nobody said the word the
loop was waiting for. Collapsing those two into one boolean would hide the
only thing worth knowing, so a loop reports both, and a flow's `loop` that
reaches its `max:` **fails** with `unconverged` rather than handing the next
node work that nobody approved.

The session did not take the hint. It ran the loop four more times, once on
a model there is no key for here, then fell back to calling the coder alone until
the file said what it wanted. The row of each call says what happened; the
session's summary at the end said it had used "a `subagent` in `loop` mode".

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
