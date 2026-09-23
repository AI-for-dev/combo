/**
 * The shipped `build` flow on a throwaway repository: a request in, work
 * reviewed, checked and audited out.
 *
 *   node examples/11-build.ts /path/to/a/throwaway/repo "add a slugify helper"
 *
 * **This one writes code.** It runs in the directory you give it, and that
 * directory must be a git repository you do not care about - an example must
 * never be able to rewrite the repository it ships in, which is why there is no
 * default and no fallback to the current directory.
 *
 * The flow's `tests` node runs `.pi/checks/test.sh` of that repository, so it
 * needs one: a script running its tests, exiting 0 when they pass. Without it
 * the run is refused before any model is called. Each subtask works in its own
 * copy, so the tree has to be **clean** to start with.
 *
 * It stops short of committing: the work stays in the working tree, and the run
 * directory under `runs/` holds the journal `/run resume` would carry on from.
 */

import * as path from "node:path";
import {
	bashCheck,
	checkFlow,
	checkRun,
	createRunDir,
	formatUsage,
	gitPort,
	isRepository,
	livePlan,
	loadFlowCatalogue,
	readJournal,
	runFlow,
	showLive,
	status,
	type Fault,
} from "../src/index.ts";
import { consoleReporter, modelOverride, positional, show } from "./shared.ts";

const [target, ...words] = positional;
const request = words.join(" ");

if (!target || !request) {
	console.error('usage: node examples/11-build.ts [--model <pattern>] <throwaway-repo> "what to build"');
	process.exit(1);
}

const cwd = path.resolve(target);
if (cwd === path.resolve(import.meta.dirname, "..")) {
	console.error("refusing to run on this repository: point me at a throwaway one");
	process.exit(1);
}
if (!(await isRepository(cwd))) {
	console.error(`${cwd} is not a git repository`);
	process.exit(1);
}

function refuse(faults: readonly Fault[]): never {
	console.error(faults.map((fault) => fault.message).join("\n"));
	process.exit(1);
}

// Both stages before the first spawn: the file against the agents it names,
// then the run against this terminal - a check port, git, and nobody to ask.
const flow = checkFlow("build", loadFlowCatalogue({ cwd, scope: "both", builtin: true }));
if (!flow.ok) refuse(flow.faults);
const checked = await checkRun(flow.flow, { cwd, ports: { check: bashCheck(), git: gitPort() }, somebodyThere: false });
if (!checked.ok) refuse(checked.faults);

const runDir = createRunDir(path.join(cwd, "runs"));
const result = await runFlow(checked.run, request, {
	model: modelOverride,
	// pi's agent loop has no step cap; never run this unattended without one.
	timeoutMs: 300_000,
	runDir,
	onEvent: consoleReporter(),
});

show("the run", showLive(livePlan(flow.flow, readJournal(runDir), []), 120));
console.log(result.ok ? `ok · ${runDir}` : `failed at ${result.path}: ${result.error.message} · ${runDir}`);
console.log(`total  ${formatUsage(result.usage)}`);

const dirty = await status(cwd);
console.log(dirty.ok && dirty.value.trim() ? `\nleft in the working tree, uncommitted:\n${dirty.value}` : "\nnothing changed on disk");
process.exit(result.ok ? 0 : 1);
