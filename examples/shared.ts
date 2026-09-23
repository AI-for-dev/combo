/**
 * What every example shares: the demo agents, and a console reporter.
 *
 * The reporter is the point: it subscribes to the event stream and prints.
 * Remove it and every example still produces exactly the same result - which
 * is what "display is an observer, never a participant" means in practice.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { consoleReporter, createRunDir, findAgent, loadAgentsFromDir, type Agent } from "../src/index.ts";

// The console reporter now lives in the library; every example wants it, and it
// is the proof that the event stream carries enough on its own.
export { consoleReporter };

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Model override for the examples: `node examples/01-run.ts --model local/qwen/qwen3-coder-next`.
 *
 * An argument, never an environment variable: ambient state reaching a
 * subagent is the exact hole this library plugs, and the examples must not
 * demonstrate it. Worth passing, too - not every provider reports token
 * usage, and the library says zero rather than inventing a number. Pick a
 * provider that does report if you want the usage lines to mean anything.
 */
const args = process.argv.slice(2);
const flag = args.indexOf("--model");
export const modelOverride: string | undefined = flag >= 0 ? args[flag + 1] : undefined;
const rest = flag >= 0 ? [...args.slice(0, flag), ...args.slice(flag + 2)] : args;

/**
 * `runs/<timestamp>/` when `--export` was passed, and nothing otherwise.
 *
 * The flag takes **no value**, unlike `--model`: one that swallowed the word
 * after it would eat the first word of the question. An example that has
 * nothing to export ignores it.
 */
export const exportDir: string | undefined = rest.includes("--export") ? createRunDir() : undefined;

/** What is left of the command line once the flags are consumed. */
export const positional: string[] = rest.filter((arg) => arg !== "--export");

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
