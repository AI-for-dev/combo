# Quickstart

## Install

```bash
npm install
npm test          # offline, no network calls
npm run typecheck
```

Node 23.6 or later is required: it runs TypeScript natively, and there is no
build step. `tsc` is used only to typecheck.

A model is needed for anything that actually talks to a provider. pi resolves it
the usual way, and the examples honour `COMBO_MODEL`:

```bash
COMBO_MODEL=local/qwen/qwen3-coder-next node examples/01-run.ts
```

Not every provider reports tokens. When one does not, the usage lines read `0`,
and that is deliberate: nothing here is estimated by counting characters. See
[Measurements](measurements.md).

## One subagent, one task

The high level form is disposable: it spawns, asks, and closes.

```typescript
import { findAgent, loadAgents, run } from "combo";

const agents = loadAgents();
const scout = findAgent(agents, "scout");

const result = await run(scout, "Find the authentication code");
console.log(result.output);
console.log(result.usage.turns, result.usage.input, result.usage.cost);
```

`run` never throws on a model failure. It returns a `Result` with `ok: false`
and an `error`, and the usage it managed to spend is still filled in.

## A subagent that remembers

The low level form gives you the object, and you decide how long it lives.

```typescript
import { spawn } from "combo";

const coder = await spawn(coderAgent, { lifetime: "workflow" });
try {
	await coder.ask("Implement the parser");
	await coder.ask("Apply these remarks: …");   // it remembers the previous turn
	console.log(coder.usage);                     // cumulative since spawn
} finally {
	await coder.close();
}
```

Whoever opens, closes. The `finally` is not decoration: an undisposed session
leaks, and closing is also what triggers an export when one was asked for.

Read [Lifetime](lifetime.md) before choosing anything other than the default.

## A workflow

Combinators take agents and give back results. They compose because they all
speak the same `Result`.

```typescript
import { chain, fanOut, loop } from "combo";

await chain({ steps: [scout, reviewer], input: "Explain how usage is measured" });

await fanOut({ agent: scout, tasks: ["find A", "find B", "find C"], concurrency: 2 });

await loop({
	steps: [coder, reviewer],
	input: "Implement the parser",
	until: (step) => step.output.includes("LGTM"),
	lifetime: "workflow",
});
```

Set a deadline on anything unattended. There is no default one, and pi's agent
loop has no step cap:

```typescript
await fanOut({ agent: scout, tasks, timeoutMs: 60_000 });   // per branch, not total
```

[Workflows](workflows.md) covers all nine.

## From pi

```bash
pi -e extension          # this session only
pi install ./extension   # permanently, via settings
```

Then, in the TUI:

```
> /build add a slugify helper with tests
> use subagent with scope "project" and agent "scout" to find the auth code
```

The demo agents of this repository live in `.pi/agents/`, which is
repository-controlled content and therefore never loaded by default - hence the
explicit `scope`. See [Agents](agents.md) and [Extension](extension.md).

## Next

- [Agents](agents.md) - write your own.
- [Workflows](workflows.md) - the shapes available.
- [Deliver a change](build.md) - the whole pipeline, from a vague request to a commit.
