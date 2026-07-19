/**
 * The disposable form: one agent, one task, no lifetime to manage.
 *
 *   node examples/01-run.ts
 *
 * What to check on a real model: `busyMs` is close to `wallMs`, because a
 * "task" subagent spends its whole life working. On a persistent one the gap
 * between the two is the interesting number.
 */

import { formatUsage, run } from "../src/index.ts";
import { agent, consoleReporter, repoRoot, show } from "./shared.ts";

const result = await run(agent("scout"), "Where is the lifetime of a subagent decided? Answer in three lines.", {
	cwd: repoRoot,
	onEvent: consoleReporter(),
});

show(result.ok ? "scout" : "scout (failed)", result.ok ? result.output : (result.error ?? "unknown error"));
console.log(formatUsage(result.usage));
