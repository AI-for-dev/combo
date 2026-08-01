/**
 * What an experiment leaves behind: one JSON document, one comparison table.
 *
 * Kept apart from the runner because they answer different questions - one
 * drives the matrix, the other reads it. Two rules govern the arithmetic here.
 *
 * **Sums first.** A summary stores totals; a mean is computed at the moment it
 * is displayed, and never stored. Averaging averages is how a study starts
 * lying about itself.
 *
 * **A failed cell stays in the report.** It ran, it cost tokens, and dropping it
 * would quietly turn "two models out of three answered" into a clean comparison
 * of the survivors.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExperimentOutcome } from "./experiment.ts";
import { formatUsage, type Usage } from "./usage.ts";

/** One cell of the matrix: one model, one repetition, once it has run. */
export type ExperimentRun = {
	/** The model pattern every subagent of this cell ran on. */
	model: string;
	/** 1-based, and the same number as the `rep-<n>/` directory. */
	repetition: number;
	/** The cell's directory, relative to the experiment's own - a report survives a move. */
	dir: string;
	/** The callback's verdict, promoted so the table can be read without opening `outcome`. */
	ok: boolean;
	/** Why it failed, when it did. A callback that threw lands here too. */
	error?: string;
	/** The callback's outcome, verbatim: the flags this study compares. */
	outcome: ExperimentOutcome;
	/** Wall time of this cell alone, measured around the callback. */
	wallMs: number;
	/** The cell's `usage.json` total - what the whole workflow spent. */
	usage: Record<string, number>;
};

/** Everything one model did, across its repetitions. */
export type ExperimentModelSummary = {
	/** The model pattern, as it was asked for. */
	model: string;
	/** Cells that ran. Lower than `repetitions` when the experiment was aborted. */
	runs: number;
	/** Cells whose callback reported success. */
	ok: number;
	/** Cells that failed. Counted apart: `3 runs` hides a crash. */
	failed: number;
	/** Per outcome flag, how many cells reported each value. `ok` and `error` excluded. */
	flags: Record<string, Record<string, number>>;
	/** Summed wall time over the cells. The mean is a display derivative. */
	wallMs: number;
	/** Summed usage over the cells, key by key. */
	total: Record<string, number>;
};

/** The whole `experiment.json` document. */
export type ExperimentReport = {
	/** What this study was called, when it was given a name. */
	name?: string;
	/** When the report was written, ISO 8601. */
	generatedAt: string;
	/** The experiment directory, absolute - the cells' `dir` is relative to it. */
	dir: string;
	/** The models compared, in the order they were given. */
	models: string[];
	/** Repetitions asked for per model, whatever was reached. */
	repetitions: number;
	/** Wall time of the experiment itself, not the sum of the cells. */
	wallMs: number;
	/** Every cell that ran, model-major. Failures included. */
	runs: ExperimentRun[];
	/** One entry per model, in the order of `models`. */
	byModel: ExperimentModelSummary[];
	/** Set when the matrix did not run whole - `"aborted"`, today. */
	error?: string;
};

/** Builds the report from the cells that ran, summarising per model. */
export function experimentReport(input: Omit<ExperimentReport, "generatedAt" | "byModel">): ExperimentReport {
	return {
		...input,
		generatedAt: new Date().toISOString(),
		byModel: input.models
			.map((model) => summarise(model, input.runs))
			.filter((summary) => summary.runs > 0),
	};
}

/**
 * The comparison table, as Markdown lines.
 *
 * Flag columns are the union of the outcome keys actually seen - a study
 * comparing `converged` gets a `converged` column without configuring one.
 */
export function experimentTable(report: ExperimentReport): string[] {
	const flags = flagKeys(report.runs);
	const header = ["model", "runs", "ok", ...flags, "usage", "mean wall", "mean $"];
	const lines = [row(header), row(header.map(() => "---"))];

	for (const summary of report.byModel) {
		lines.push(
			row([
				summary.model,
				String(summary.runs),
				`${summary.ok}/${summary.runs}`,
				...flags.map((key) => formatFlag(summary.flags[key], summary.runs)),
				formatUsage(asUsage(summary)),
				`${(summary.wallMs / summary.runs / 1000).toFixed(1)}s`,
				`$${((summary.total.cost ?? 0) / summary.runs).toFixed(4)}`,
			]),
		);
	}

	return lines;
}

/** Writes `experiment.json` and `experiment.md` into `dir`, and returns their paths. */
export function writeExperimentReport(dir: string, report: ExperimentReport): { json: string; markdown: string } {
	fs.mkdirSync(dir, { recursive: true });
	const json = path.join(dir, "experiment.json");
	const markdown = path.join(dir, "experiment.md");
	fs.writeFileSync(json, `${JSON.stringify(report, null, "\t")}\n`);
	fs.writeFileSync(markdown, experimentMarkdown(report));
	return { json, markdown };
}

/** The document around the table: what was compared, and what failed. */
function experimentMarkdown(report: ExperimentReport): string {
	const lines = [
		`# ${report.name ?? "Experiment"}`,
		"",
		`${report.models.length} model${report.models.length > 1 ? "s" : ""} × ${report.repetitions} repetition${
			report.repetitions > 1 ? "s" : ""
		}, ${(report.wallMs / 1000).toFixed(1)}s wall, ${report.generatedAt}.`,
		"",
	];
	if (report.error) lines.push(`**${report.error}** - this report is partial.`, "");
	lines.push(...experimentTable(report));

	const failures = report.runs.filter((one) => !one.ok);
	if (failures.length > 0) {
		lines.push("", "## Failures", "");
		for (const one of failures) lines.push(`- \`${one.dir}\` - ${one.error ?? "failed"}`);
	}

	return `${lines.join("\n")}\n`;
}

function summarise(model: string, runs: readonly ExperimentRun[]): ExperimentModelSummary {
	const mine = runs.filter((one) => one.model === model);
	const summary: ExperimentModelSummary = {
		model,
		runs: mine.length,
		ok: mine.filter((one) => one.ok).length,
		failed: mine.filter((one) => !one.ok).length,
		flags: {},
		wallMs: 0,
		total: {},
	};

	for (const one of mine) {
		summary.wallMs += one.wallMs;
		for (const [key, value] of Object.entries(one.usage)) summary.total[key] = (summary.total[key] ?? 0) + value;
		for (const [key, value] of flagsOf(one.outcome)) {
			const counts = (summary.flags[key] ??= {});
			counts[value] = (counts[value] ?? 0) + 1;
		}
	}

	return summary;
}

/**
 * The outcome, minus what already has a column of its own.
 *
 * `ok` is the verdict, not a flag, and `error` is free text: a column of
 * distinct sentences compares nothing.
 */
function flagsOf(outcome: ExperimentOutcome): [string, string][] {
	return Object.entries(outcome)
		.filter(([key, value]) => key !== "ok" && key !== "error" && value !== undefined)
		.map(([key, value]) => [key, String(value)]);
}

function flagKeys(runs: readonly ExperimentRun[]): string[] {
	const keys = new Set<string>();
	for (const one of runs) for (const [key] of flagsOf(one.outcome)) keys.add(key);
	return [...keys];
}

/** `3/4` for a boolean flag, `2×1 3×2` for anything else. */
function formatFlag(counts: Record<string, number> | undefined, runs: number): string {
	if (!counts) return "-";
	const keys = Object.keys(counts);
	if (keys.every((key) => key === "true" || key === "false")) return `${counts.true ?? 0}/${runs}`;
	return keys
		.sort()
		.map((key) => `${key}×${counts[key]}`)
		.join(" ");
}

/** A summed record back into a {@link Usage}, so the existing formatting applies. */
function asUsage(summary: ExperimentModelSummary): Usage {
	const total = summary.total;
	return {
		wallMs: summary.wallMs,
		busyMs: total.busyMs ?? 0,
		turns: total.turns ?? 0,
		input: total.input ?? 0,
		output: total.output ?? 0,
		cacheRead: total.cacheRead ?? 0,
		cacheWrite: total.cacheWrite ?? 0,
		cost: total.cost ?? 0,
	};
}

function row(cells: readonly string[]): string {
	return `| ${cells.join(" | ")} |`;
}
