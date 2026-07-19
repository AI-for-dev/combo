/**
 * Exporting a run: `runs/<timestamp>/` with one HTML and one JSONL per
 * subagent, plus a `usage.json`.
 *
 * Two rules govern this file.
 *
 * **We reimplement nothing.** The HTML and the JSONL are pi's own
 * (`AgentSession.exportToHtml` / `exportToJsonl`); `usage.json` is the single
 * artefact we produce ourselves, because it is the only one pi does not know
 * about - time is measured here, and attribution per subagent is ours.
 *
 * **An export never breaks a run.** Every failure comes back as a string in
 * `error`, never as a throw: an export is an observer of the work, and an
 * observer that takes the workflow down with it is a bug. That matters most on
 * the interrupted path, where exporting is precisely what we are trying to
 * rescue.
 */

import fs from "node:fs";
import path from "node:path";
import type { TuiSnapshot } from "./reporters/tui.ts";
import type { SessionPort } from "./session.ts";

/** What one subagent left on disk. Both paths are absent when nothing could be written. */
export type SessionExport = {
	id: string;
	html?: string;
	jsonl?: string;
	/** Why the export did not happen. Never thrown, always reported. */
	error?: string;
};

/**
 * Creates `<base>/<timestamp>/` and returns its path.
 *
 * The timestamp is sortable and filesystem-safe, so two runs never collide and
 * `ls` shows them in order.
 */
export function createRunDir(base = "runs", now = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
	const dir = path.resolve(base, stamp);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Turns a subagent id into a file name: `reviewer#2` → `reviewer-2`.
 *
 * `#` is legal in a file name and unusable in a URL, and these files are meant
 * to be opened in a browser and shared.
 */
export function exportBaseName(id: string): string {
	return id.replace(/[#/\\:]/g, "-");
}

/**
 * Exports one **live** session into `dir`.
 *
 * Must be called before `dispose()`: afterwards the session is gone and the
 * transcript with it. Each format is attempted on its own - an in-memory
 * session still yields its JSONL even though pi refuses to render its HTML.
 */
export async function exportSession(session: SessionPort, dir: string, id: string): Promise<SessionExport> {
	const name = exportBaseName(id);
	const result: SessionExport = { id };
	const problems: string[] = [];

	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (cause) {
		return { id, error: message(cause) };
	}

	try {
		result.jsonl = session.exportToJsonl?.(path.join(dir, `${name}.jsonl`));
	} catch (cause) {
		problems.push(`jsonl: ${message(cause)}`);
	}

	try {
		result.html = await session.exportToHtml?.(path.join(dir, `${name}.html`));
	} catch (cause) {
		problems.push(`html: ${message(cause)}`);
	}

	if (problems.length > 0) result.error = problems.join("; ");
	return result;
}

/** One subagent's line in `usage.json`. */
export type UsageReportEntry = {
	id: string;
	agent: string;
	lifetime: string;
	model?: string;
	status: string;
	ok?: boolean;
	error?: string;
	task: string;
	toolCalls: number;
	usage: Record<string, number | undefined>;
};

/** The whole `usage.json` document. */
export type UsageReport = {
	generatedAt: string;
	/** Wall time of the run itself, not the sum of the subagents. */
	wallMs: number;
	subagents: UsageReportEntry[];
	total: Record<string, number>;
	/** Busy time over wall time: the parallelism actually achieved. */
	parallelism: number;
	exports?: SessionExport[];
};

/**
 * Builds the report from a collected snapshot.
 *
 * A fan-out **aggregates**, it never averages: tokens and cost are sums,
 * `busyMs` is the sum of the branches, and `wallMs` is how long the run took.
 * The ratio of the last two is the only honest measure of parallelism.
 */
export function usageReport(snapshot: TuiSnapshot, wallMs: number, exports?: SessionExport[]): UsageReport {
	const total = snapshot.usage;
	return {
		generatedAt: new Date().toISOString(),
		wallMs,
		subagents: snapshot.subagents.map((one) => ({
			id: one.id,
			agent: one.agent,
			lifetime: one.lifetime,
			model: one.model,
			status: one.status,
			ok: one.ok,
			error: one.error,
			task: one.task,
			toolCalls: one.tools.length,
			usage: { ...one.usage },
		})),
		total: {
			subagents: snapshot.subagents.length,
			failed: snapshot.failed,
			turns: total.turns,
			busyMs: total.busyMs,
			input: total.input,
			output: total.output,
			cacheRead: total.cacheRead,
			cacheWrite: total.cacheWrite,
			cost: total.cost,
		},
		parallelism: wallMs > 0 ? total.busyMs / wallMs : 0,
	};
}

/** Writes `usage.json` into `dir` and returns its path. */
export function writeUsageReport(dir: string, report: UsageReport): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "usage.json");
	fs.writeFileSync(file, `${JSON.stringify(report, null, "\t")}\n`);
	return file;
}

/**
 * Copies the parent session's JSONL next to the subagents' exports.
 *
 * An orchestration export that lost the parent would be half a story. HTML is
 * missing here on purpose: pi's HTML exporter is a method of `AgentSession`,
 * and an extension only ever sees a `ReadonlySessionManager` - the renderer is
 * not on pi's public surface. `pi --export <file>` turns this JSONL into the
 * same HTML whenever it is wanted.
 */
export function copyMainSession(sessionFile: string | undefined, dir: string): SessionExport {
	if (!sessionFile) return { id: "main", error: "no session file: the parent session is in memory" };
	try {
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, "main.jsonl");
		fs.copyFileSync(sessionFile, target);
		return { id: "main", jsonl: target };
	} catch (cause) {
		return { id: "main", error: message(cause) };
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
