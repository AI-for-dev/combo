---
myst:
  html_meta:
    "description": "Twelve sittings in front of pi, each around one problem agents have today, each run on this repository."
---

# Tutorials

The [guide](../guide/quickstart.md) explains combo one concept at a time. These
pages start from the other end: each one sits you in front of pi with a
problem people are having with agents right now, and has you run the thing
that answers it. Every page ends with the question it could not answer, and
the next page opens on it, so they read in order and each one is short.

Everything runs on this repository. Clone it, install, load the extension, and
nothing has to be copied anywhere:

```bash
git clone https://github.com/AI-for-dev/combo && cd combo
npm install
pi -e extension
```

You need a model pi can reach. The frames shown here were drawn by a real pi,
0.85.1, with every subagent on `ilaas/gemma-4-31b`, a small open-weight model
served locally. A slow, cheap model is where every weakness shows, and none of
what follows depends on a strong one. Where a page quotes a number, it says
what produced it.

## The twelve
**Reading.** The session's context is the scarce thing, and every page here
spends someone else's instead.

1. [A scout reads twenty files so you do not have to](01-one-scout.md) - the
   first subagent, and what your own window looks like afterwards.
2. [Three scouts, one answer](02-three-scouts.md) - `/run explore`: the reading
   in parallel, the answer in your conversation, a failed branch shown rather than
   dropped.
3. [Keep the session out of it](03-keep-the-session-out.md) - `/step`: a chain
   walked by hand, with the main model told nothing until you say so, and a
   different model per step.


```{toctree}
:maxdepth: 1
:hidden:

01-one-scout
02-three-scouts
03-keep-the-session-out
```
