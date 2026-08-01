/**
 * The same loop, on several models, twice each.
 *
 *   node examples/12-experiment.ts ilaas/qwen-3.6-35b-instruct local/qwen/qwen3-coder-next
 *
 * What to check: `runs/<timestamp>/` holds one directory per model, `rep-1/` and
 * `rep-2/` inside it with the transcripts and a `usage.json`, and at the root
 * the two files the study is for - `experiment.json` and `experiment.md`.
 *
 * The interesting column is `converged`: `2/2` means the reviewer said LGTM both
 * times. A model that never converges but costs a tenth of another is a real
 * answer, and it is exactly the comparison a single run cannot give you.
 *
 * Cells run one at a time on purpose. Two models racing for the same machine
 * measure the contention, not the models.
 */

import { experiment, experimentTable, loop, READ_ONLY_TOOLS } from "../src/index.ts";
import { agent, consoleReporter, positional, repoRoot } from "./shared.ts";

if (positional.length === 0) {
	console.error("usage: node examples/12-experiment.ts <modelA> [modelB …]");
	process.exit(1);
}

// Read-only, like every example that ships in this repository: a prompt is not
// a permission boundary, the toolset is.
const steps = [{ ...agent("coder"), tools: [...READ_ONLY_TOOLS] }, agent("reviewer")];
const input = [
	"In src/usage.ts, review formatUsage and its compact/trim helpers.",
	"Describe the change you would make, then hand it to the reviewer.",
].join(" ");

const report = await experiment({
	name: "loop convergence",
	models: positional,
	repetitions: 2,
	cwd: repoRoot,
	// pi's agent loop has no step cap; an unattended matrix needs one. Measured:
	// at 120s these two models lost half the cells to a coder still reading.
	timeoutMs: 300_000,
	onEvent: consoleReporter(),
	run: async (cell) => {
		// Spreading `cell.options` is the whole contract: the model, the export
		// directory and the measurement all ride on it.
		const result = await loop({
			...cell.options,
			steps,
			input,
			lifetime: "workflow",
			until: (step) => step.output.includes("LGTM"),
			maxIterations: 3,
		});
		return { ok: result.ok, error: result.error, converged: result.converged, iterations: result.iterations };
	},
});

console.log(`\n${experimentTable(report).join("\n")}\n`);
console.log(`written to ${report.dir}`);
