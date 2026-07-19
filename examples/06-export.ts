/**
 * Exporting a run: transcripts on disk, measurements beside them.
 *
 *   node examples/06-export.ts
 *
 * What to check: `runs/<timestamp>/` holds one HTML and one JSONL per subagent
 * - pi's own, we render nothing ourselves - and a `usage.json` we do produce,
 * because time and attribution per subagent are the two things pi does not
 * know about.
 *
 * The interesting line is `parallelism`: busy time over wall time. Two branches
 * that really ran side by side land near ×2; anything near ×1 means they
 * queued.
 */

import { createRunDir, createTuiCollector, combineReporters, fanOut, usageReport, writeUsageReport } from "../src/index.ts";
import { agent, consoleReporter, repoRoot, show } from "./shared.ts";

// Created up front: subagents export themselves as they close.
const dir = createRunDir();

// The collector is what usage.json is built from - the same state the TUI
// draws. One stream, several observers.
const collector = createTuiCollector();

const startedAt = performance.now();
const { results } = await fanOut({
	agent: agent("scout"),
	tasks: [
		"How is the lifetime of a subagent chosen? Answer in two lines.",
		"Why is per-turn usage a delta of two snapshots? Answer in two lines.",
	],
	concurrency: 2,
	cwd: repoRoot,
	exportDir: dir,
	onEvent: combineReporters(collector.reporter, consoleReporter()),
});

for (const [index, result] of results.entries()) {
	show(`branch ${index + 1}${result.ok ? "" : " (failed)"}`, result.ok ? result.output : (result.error ?? "unknown"));
}

const report = usageReport(collector.snapshot(), performance.now() - startedAt);
writeUsageReport(dir, report);

console.log(`exported to ${dir}`);
console.log(`parallelism: ×${report.parallelism.toFixed(2)}`);
