/**
 * The run stage of validation: a checked flow held to the project it is about
 * to run in, still before the first spawn.
 *
 * What the flow stage cannot know is here: the working tree, the ports the
 * launch hands over, and whether somebody is there. A flow valid on its own may
 * be refused on one project, since a check script belongs to the project.
 * What passes is a `CheckedRun`, which carries the tree and ports it was
 * checked against, so a flow checked for one project cannot run in another.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckScript } from "../verify.ts";
import type { CheckedCheckNode, CheckedFlow } from "./checked.ts";
import { FaultList, type Fault } from "./fault.ts";
import { everyNode } from "./node.ts";

/** How a run reaches the world. A node whose port is absent refuses the run. */
export type FlowPorts = {
	/** Runs a `check` node's script. */
	readonly check?: CheckScript;
};

/** What a launch says about where it runs. */
export type RunStage = {
	/** The working tree, at the repository root: a check's path starts there. */
	readonly cwd: string;
	readonly ports: FlowPorts;
	/** Whether a person can answer. */
	readonly somebodyThere: boolean;
};

declare const checked: unique symbol;

/** A checked flow that passed the run stage too. Only `checkRun` makes one, and it is what `runFlow` takes. */
export type CheckedRun = RunStage & {
	readonly flow: CheckedFlow;
	/**
	 * Each check script's content by its path, read here: what runs is what was
	 * read before the first spawn, whatever an agent does to the file after.
	 */
	readonly scripts: ReadonlyMap<string, string>;
	readonly [checked]: true;
};

/** A checked run, or every fault that refused it. */
export type CheckRun = { readonly ok: true; readonly run: CheckedRun } | { readonly ok: false; readonly faults: readonly Fault[] };

/** `flow` held to `stage`. A missing port and a missing script are each reported once, at the first node needing it. */
export function checkRun(flow: CheckedFlow, stage: RunStage): CheckRun {
	const faults = new FaultList(flow.file);
	const checks = [...everyNode(flow.nodes)].filter((node): node is CheckedCheckNode => node.kind === "check");
	const first = checks[0];
	if (first !== undefined && stage.ports.check === undefined) {
		faults.add("check-port-missing", `${first.at}.check`, "this run was given no `check` port to run a script with");
	}
	const scripts = new Map<string, string>();
	const missing = new Set<string>();
	for (const node of checks) {
		if (scripts.has(node.script) || missing.has(node.script)) continue;
		try {
			scripts.set(node.script, readFileSync(join(stage.cwd, node.script), "utf-8"));
		} catch (error) {
			missing.add(node.script);
			const code = (error as NodeJS.ErrnoException).code;
			const why = code === "ENOENT" ? "is not there" : code === "EISDIR" ? "is a directory" : `cannot be read: ${(error as Error).message}`;
			faults.add("check-script-missing", `${node.at}.check`, `\`${node.script}\` ${why}, from \`${stage.cwd}\``);
		}
	}
	if (faults.list.length > 0) return { ok: false, faults: faults.list };
	return { ok: true, run: { ...stage, flow, scripts } as unknown as CheckedRun };
}
