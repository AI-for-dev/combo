/**
 * The floor every command test stands on: a roster, no flow, no file left in
 * an old `pipelines/` directory, a folder that is never written, and no
 * repaint timer.
 *
 * Each test lays its own doubles over it - the flows it runs, the interview
 * that briefs - because those are what the test is about. This is
 * only what none of them is about.
 */

import type { CommandDeps } from "../../extension/deps.ts";
import type { Agent } from "../../src/index.ts";

export function baseDeps(agents: readonly Agent[], runDir = "/tmp/never-written"): CommandDeps {
	return {
		loadAgents: () => [...agents],
		loadFlowCatalogue: () => ({ flows: [], agents: [...agents], brokenAgents: [], cwd: "." }),
		removedPipelines: () => [],
		runDir: () => runDir,
		tickMs: 0,
	};
}
