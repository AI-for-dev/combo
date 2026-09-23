/**
 * The run stage of validation: a checked flow held to the project it is about
 * to run in, still before the first spawn.
 *
 * What the flow stage cannot know is here: the working tree, the ports the
 * launch hands over, and whether somebody is there. A flow valid on its own may
 * be refused on one project, since a check script belongs to the project,
 * and a commit, a copy or a read of `diff` needs a repository. With nobody
 * there, a flow that could reach a question nobody can leave unanswered is
 * refused now rather than failed there, behind a `choice` too: whether a case
 * is taken is only known once the run has spent what came before it.
 * What passes is a `CheckedRun`, which carries the tree and ports it was
 * checked against, so a flow checked for one project cannot run in another.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AskUser } from "../ask.ts";
import type { GitPort } from "../git/index.ts";
import type { CheckScript } from "../verify.ts";
import type { CheckedCheckNode, CheckedFlow, CheckedNode } from "./checked.ts";
import { FaultList, type Fault } from "./fault.ts";
import { everyNode } from "./node.ts";

/** How a run reaches the world. A node whose port is absent refuses the run; without `ask`, nobody is there. */
export type FlowPorts = {
	/** Puts an `ask` node's question to the person. */
	readonly ask?: AskUser;
	/** Runs a `check` node's script. */
	readonly check?: CheckScript;
	/** Commits, reads `diff`, and makes and lands the copies of a `copies: true` block. */
	readonly git?: GitPort;
};

/** What a launch says about where it runs. */
export type RunStage = {
	/** The working tree, at the repository root: a check's path starts there. */
	readonly cwd: string;
	readonly ports: FlowPorts;
	/** Whether a person can answer. With no `ask` port, nobody can, whatever this says. */
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

/** `flow` held to `stage`. A missing port, a missing script and a tree that is no repository are each reported once, at the first node needing it. */
export async function checkRun(flow: CheckedFlow, stage: RunStage): Promise<CheckRun> {
	const faults = new FaultList(flow.file);
	const nodes = [...everyNode(flow.nodes)];
	const git = nodes.map(needsGit).find((at) => at !== undefined);
	if (git !== undefined && stage.ports.git === undefined) {
		faults.add("git-port-missing", git, "this run was given no `git` port to commit, read `diff` or make copies with");
	} else if (git !== undefined && !(await stage.ports.git?.isRepository(stage.cwd))) {
		faults.add("not-a-repository", git, `\`${stage.cwd}\` is not in a git repository`);
	}
	const checks = nodes.filter((node): node is CheckedCheckNode => node.kind === "check");
	const first = checks[0];
	if (first !== undefined && stage.ports.check === undefined) {
		faults.add("check-port-missing", `${first.at}.check`, "this run was given no `check` port to run a script with");
	}
	const there = stage.somebodyThere && stage.ports.ask !== undefined;
	for (const node of nodes) {
		if (there || node.kind !== "ask" || node.default !== undefined || node.enough !== undefined) continue;
		const why = stage.ports.ask === undefined ? "this run was given no `ask` port" : "this run is launched with nobody there";
		faults.add("unattended-ask", `${node.at}.${"from" in node.question ? "ask-from" : "ask"}`, `${why}, and nobody answering this question has no value: give it \`default:\`, or \`enough:\` on a choice card`);
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
	// Each fault is a node's key; they come back in the order of the file.
	const order = nodes.map((node) => node.at);
	faults.sort((fault) => order.indexOf(fault.at.slice(0, fault.at.lastIndexOf("."))));
	if (faults.list.length > 0) return { ok: false, faults: faults.list };
	return { ok: true, run: { ...stage, flow, scripts } as unknown as CheckedRun };
}

/** Where `node` needs git, when it does: a commit, a block's copies, a read of `diff`. */
function needsGit(node: CheckedNode): string | undefined {
	if (node.kind === "commit") return `${node.at}.commit`;
	if ((node.kind === "parallel" || node.kind === "map") && node.copies) return `${node.at}.copies`;
	if ((node.kind === "agent" || node.kind === "ask") && node.reads.some((read) => read.address === "diff")) return `${node.at}.reads`;
	return undefined;
}
