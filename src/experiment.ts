/**
 * Running the same work across several models, several times.
 *
 * This is the layer the `model` knob exists for: one workflow, M models, N
 * repetitions, and one table at the end saying what each model cost and whether
 * it got there.
 *
 * An experiment is **a function, not a combinator**. It returns no `Result` and
 * composes with nothing: it is a harness placed above a workflow, and a harness
 * that could be nested inside one would be measuring itself. What runs inside a
 * cell is the caller's business - a combinator, a `runPipeline`, or a whole
 * script - and the only contract is that the cell's `options` are spread into
 * it, so every subagent lands on that cell's model and in that cell's directory.
 *
 * Measurement is reused, never reinvented: each cell gets its own collector, its
 * `usage.json` is the same document a single run writes, and its whole event
 * stream is kept in `events.jsonl` next to it.
 */

import fs from "node:fs";
import path from "node:path";
import {
	experimentReport,
	writeExperimentReport,
	type ExperimentReport,
	type ExperimentRun,
} from "./experiment-report.ts";
import { createRunDir, exportBaseName, usageReport, writeUsageReport } from "./export.ts";
import type { EventListener } from "./events.ts";
import { combineReporters, createTuiCollector, recordReporter } from "./reporters/index.ts";
import { abortError, mapConcurrent, type SpawnFn, type WorkflowOptions } from "./workflows/common.ts";

/**
 * What a cell reports back: a verdict, plus the flat flags the study compares.
 *
 * `converged`, `approved`, `iterations`, `rounds` - whatever the callback
 * chooses. They become the table's columns, so they are scalars: anything the
 * comparison needs is put here, anything else stays in the cell's transcripts.
 */
export type ExperimentOutcome = {
	/** Did this cell do the work? The one flag with a column of its own. */
	ok: boolean;
	/** What went wrong. Never a column: distinct sentences compare nothing. */
	error?: string;
} & Record<string, string | number | boolean | undefined>;

/** One cell of the matrix, handed to the callback. */
export type ExperimentCell = {
	/** The model every subagent of this cell must run on. */
	model: string;
	/** 1-based, and the same number as the `rep-<n>/` directory. */
	repetition: number;
	/** This cell's export directory, absolute. Already created. */
	dir: string;
	/**
	 * Ready to be spread into any combinator or into `runPipeline`.
	 *
	 * Spreading it is the contract: it carries the cell's `model` and
	 * `exportDir`, the experiment's `signal`, `timeoutMs`, `cwd` and `spawn`, and
	 * an `onEvent` combining the cell's own collector, its `events.jsonl`
	 * recorder and the caller's listener. A callback that rebuilds these by hand
	 * measures something else.
	 */
	options: WorkflowOptions;
};

/** The matrix, and what to run in each of its cells. */
export type ExperimentOptions = {
	/** The models to compare. One block of cells each, in this order. */
	models: string[];
	/** Repetitions per model. Defaults to 1. */
	repetitions?: number;
	/**
	 * Cells in flight. Defaults to **1**, and that default is the point: two
	 * cells racing for the same machine measure the contention, not the models.
	 */
	concurrency?: number;
	/** The work itself. Spread `cell.options` into it, return the flags to compare. */
	run: (cell: ExperimentCell) => Promise<ExperimentOutcome>;
	/** Shown at the top of `experiment.md`. */
	name?: string;
	/** Where `<timestamp>/` is created. Defaults to `"runs"`. */
	runsDir?: string;
	/** Stops launching new cells. What already ran is still reported. */
	signal?: AbortSignal;
	/** Per-turn deadline, passed down to every cell. No default. */
	timeoutMs?: number;
	/** Working directory of every subagent. */
	cwd?: string;
	/** A listener over the whole experiment, combined with each cell's collector. */
	onEvent?: EventListener;
	/** Defaults to the real `spawn`. The injection point that keeps tests offline. */
	spawn?: SpawnFn;
};

/**
 * Runs the matrix and writes the report.
 *
 * Cells are built model-major - every repetition of the first model, then the
 * second - so a run interrupted halfway has finished models rather than a
 * fragment of each.
 *
 * A callback that fails, or throws, becomes a cell with `ok: false` **and its
 * usage**: it spent tokens before it broke, and the report says so. An aborted
 * signal stops launching new cells and the partial report is still written.
 */
export async function experiment(options: ExperimentOptions): Promise<ExperimentReport> {
	const { models, signal } = options;
	const repetitions = options.repetitions ?? 1;

	if (models.length === 0) throw new Error("experiment: `models` is empty");
	if (repetitions < 1) throw new Error(`experiment: \`repetitions\` must be at least 1, got ${repetitions}`);

	const dir = createRunDir(options.runsDir ?? "runs");
	const cells = models.flatMap((model) =>
		Array.from({ length: repetitions }, (_, index) => ({ model, repetition: index + 1 })),
	);

	const startedAt = performance.now();
	const finished = await mapConcurrent(cells, Math.max(1, options.concurrency ?? 1), async (cell) =>
		signal?.aborted ? undefined : runCell(cell.model, cell.repetition, dir, options),
	);

	const report = experimentReport({
		name: options.name,
		dir,
		models,
		repetitions,
		wallMs: performance.now() - startedAt,
		runs: finished.filter((one): one is ExperimentRun => one !== undefined),
		error: abortError(signal),
	});

	writeExperimentReport(dir, report);
	return report;
}

/** One model, one repetition: its own directory, its own collector, its own `usage.json`. */
async function runCell(
	model: string,
	repetition: number,
	root: string,
	options: ExperimentOptions,
): Promise<ExperimentRun> {
	const dir = path.join(root, exportBaseName(model), `rep-${repetition}`);
	fs.mkdirSync(dir, { recursive: true });

	const collector = createTuiCollector();
	const cell: ExperimentCell = {
		model,
		repetition,
		dir,
		options: {
			model,
			exportDir: dir,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
			cwd: options.cwd,
			spawn: options.spawn,
			// The recorder is not optional: a cell whose stream was not kept is a
			// cell that can only ever be re-run, and a matrix is expensive.
			onEvent: combineReporters(
				collector.reporter,
				recordReporter(path.join(dir, "events.jsonl")),
				options.onEvent,
			),
		},
	};

	const startedAt = performance.now();
	let outcome: ExperimentOutcome;
	try {
		outcome = await options.run(cell);
	} catch (cause) {
		// A callback that throws is a cell that failed, not an experiment that
		// crashed: the other cells still have something to say.
		outcome = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
	const wallMs = performance.now() - startedAt;

	const usage = usageReport(collector.snapshot(), wallMs);
	writeUsageReport(dir, usage);

	return {
		model,
		repetition,
		dir: path.relative(root, dir),
		ok: outcome.ok,
		error: outcome.error,
		outcome,
		wallMs,
		usage: usage.total,
	};
}
