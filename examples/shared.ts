/**
 * What every example shares: the demo agents, and a console reporter.
 *
 * The reporter is the point: it subscribes to the event stream and prints.
 * Remove it and every example still produces exactly the same result - which
 * is what "display is an observer, never a participant" means in practice.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findAgent, formatUsage, loadAgentsFromDir, type Agent, type SubagentEvent } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Model override for the examples: `PI_SUBAGENT_MODEL=local/qwen/qwen3-coder-next`.
 *
 * Worth setting. Not every provider reports token usage - several report zero,
 * and the library says zero rather than inventing a number. Pick a provider
 * that does report if you want the usage lines to mean anything.
 */
const modelOverride = process.env.PI_SUBAGENT_MODEL;

/** The demo agents shipped with this repository. */
export const agents: Agent[] = loadAgentsFromDir(path.join(here, "..", "agents"), "project").map((definition) =>
	modelOverride ? { ...definition, model: modelOverride } : definition,
);

export const agent = (name: string) => findAgent(agents, name);

/** Repository root, used as the working directory for the demo agents. */
export const repoRoot = path.join(here, "..");

/**
 * Prints subagents as they work. Tool calls are shown as they arrive, never
 * buffered until the end - an opaque spinner tells you nothing.
 */
export function consoleReporter(): (event: SubagentEvent) => void {
	const lines = new Map<string, string>();

	return (event) => {
		switch (event.type) {
			case "spawn":
				lines.set(event.id, event.agent);
				console.log(`\n⏳ ${event.id}  (lifetime: ${event.lifetime})`);
				break;
			case "tool":
				console.log(`   · ${event.id} → ${event.name}`);
				break;
			case "usage":
				console.log(`   ${event.id}  ${formatUsage(event.usage)}`);
				break;
			case "close":
				console.log(`✓ ${event.id}  ${formatUsage(event.result.usage)}`);
				break;
			default:
				break;
		}
	};
}

/** Prints a result, or its error. */
export function show(label: string, output: string): void {
	console.log(`\n──── ${label} ────\n${output}\n`);
}
