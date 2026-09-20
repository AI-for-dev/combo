/**
 * The floor every command test stands on: a roster, a catalogue, a folder that
 * is never written, and no repaint timer.
 *
 * Each test lays its own doubles over it - the pipeline that answers, the
 * interview that briefs - because those are what the test is about. This is
 * only what none of them is about.
 */

import type { CommandDeps } from "../../extension/deps.ts";
import type { Agent, Pipeline } from "../../src/index.ts";

export function baseDeps(agents: readonly Agent[], pipelines: readonly Pipeline[] = [], runDir = "/tmp/never-written"): CommandDeps {
	return {
		loadAgents: () => [...agents],
		loadPipelines: () => ({ pipelines: [...pipelines], broken: [] }),
		runDir: () => runDir,
		tickMs: 0,
	};
}
