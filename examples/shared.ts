/**
 * What every example shares: the demo agents, and a console reporter.
 *
 * The reporter is the point: it subscribes to the event stream and prints.
 * Remove it and every example still produces exactly the same result - which
 * is what "display is an observer, never a participant" means in practice.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { consoleReporter, findAgent, loadAgentsFromDir, type Agent } from "../src/index.ts";

// The console reporter now lives in the library; every example wants it, and it
// is the proof that the event stream carries enough on its own.
export { consoleReporter };

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Model override for the examples: `COMBO_MODEL=local/qwen/qwen3-coder-next`.
 *
 * Worth setting. Not every provider reports token usage - several report zero,
 * and the library says zero rather than inventing a number. Pick a provider
 * that does report if you want the usage lines to mean anything.
 */
const modelOverride = process.env.COMBO_MODEL;

/** The demo agents shipped with this repository. */
export const agents: Agent[] = loadAgentsFromDir(path.join(here, "..", "agents"), "project").map((definition) =>
	modelOverride ? { ...definition, model: modelOverride } : definition,
);

export const agent = (name: string) => findAgent(agents, name);

/** Repository root, used as the working directory for the demo agents. */
export const repoRoot = path.join(here, "..");

/** Prints a result, or its error. */
export function show(label: string, output: string): void {
	console.log(`\n──── ${label} ────\n${output}\n`);
}
