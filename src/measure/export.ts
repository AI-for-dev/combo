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
import type { RunSnapshot } from "../reporters/picture.ts";
import type { Usage } from "../usage.ts";
import { treeOrder } from "../reporters/tree.ts";
import type { SessionPort } from "../session.ts";

/** What one subagent left on disk. Both paths are absent when nothing could be written. */
export type SessionExport = {
	/** The subagent this transcript belongs to, e.g. `reviewer#2`. */
	id: string;
	/** Path of the HTML page pi rendered. Absent when it could not be produced. */
	html?: string;
	/** Path of the JSONL transcript. Attempted separately from the HTML. */
	jsonl?: string;
	/** Why the export did not happen. Never thrown, always reported. */
	error?: string;
};

/**
 * Creates `<base>/<timestamp>/` and returns its path.
 *
 * The timestamp is sortable and filesystem-safe, so two runs never collide and
 * `ls` shows them in order.
 *
 * `<base>` is given a `.gitignore` of its own, because the exports land **inside
 * the repository the run works on** and git has no reason to know about them.
 * Measured, both ways round: a delivery that gives its subtasks copies refuses
 * to put them back, because `runs/` alone makes the tree unclean; and `/build`'s
 * commit is a `git add -A`, which would sweep a run's transcripts into the
 * user's history. A file already there is left alone - it is their directory
 * once they have said anything about it.
 */
export function createRunDir(base = "runs", now = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
	const dir = path.resolve(base, stamp);
	fs.mkdirSync(dir, { recursive: true });
	ignoreDir(path.resolve(base));
	return dir;
}

/** Writes `*` into `<dir>/.gitignore`, unless something is there already. */
function ignoreDir(dir: string): void {
	const marker = path.join(dir, ".gitignore");
	try {
		if (!fs.existsSync(marker)) fs.writeFileSync(marker, "*\n");
	} catch {
		// Keeping the exports out of git is worth a try, never a failed run.
	}
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
 * The first of `base`, `base~2`, `base~3`... under which `dir` holds no file
 * with any of `extensions`, and that is not in `taken` as `<dir>/<name>`:
 * what a later life of a run, or a second subagent in the same place, is
 * named, so that nothing already written is overwritten.
 */
export function freeName(dir: string, base: string, extensions: readonly string[], taken: ReadonlySet<string> = new Set()): string {
	for (let n = 1; ; n++) {
		const name = n === 1 ? base : `${base}~${n}`;
		if (!taken.has(path.join(dir, name)) && extensions.every((extension) => !fs.existsSync(path.join(dir, `${name}${extension}`)))) return name;
	}
}

/**
 * Exports one **live** session into `dir`, as `<name>.jsonl` and `.html`.
 *
 * Must be called before `dispose()`: afterwards the session is gone and the
 * transcript with it. Each format is attempted on its own - an in-memory
 * session still yields its JSONL even though pi refuses to render its HTML.
 */
export async function exportSession(session: SessionPort, dir: string, id: string, name = exportBaseName(id)): Promise<SessionExport> {
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
	/** The subagent, e.g. `scout#1` - what the transcript files are named after. */
	id: string;
	/** The agent it was spawned from. Several subagents may share one agent. */
	agent: string;
	/** The lifetime it actually ran with, not the agent's declared default. */
	lifetime: string;
	/** `provider/id` as pi resolved it, when pi could say. */
	model?: string;
	/** Its last known status: what it was doing when the run ended. */
	status: string;
	/** Whether its last turn succeeded. Absent while it is still running. */
	ok?: boolean;
	/** The failure, when there was one. A failed subagent keeps its usage. */
	error?: string;
	/** The last task it was given - a report of ids alone reads like nothing. */
	task: string;
	/** How many tools it called. The cheapest signal that a turn ran away. */
	toolCalls: number;
	/**
	 * The subagent that had this one spawned. Absent on a root.
	 *
	 * The list stays **flat** and carries the link, rather than nesting: the
	 * total is a sum over the whole tree either way, every reader written
	 * against the flat shape keeps working, and a tree is one pass away for
	 * whoever wants one. The rows are in tree order, so reading it top to bottom
	 * already shows the children under their parent.
	 */
	parentId?: string;
	/** Its {@link Usage}: time measured here, tokens as pi reported them. */
	usage: Usage;
	/** In a flow run: the folder of its transcript, relative to the run directory - its memory scope's path, else its visit's. */
	home?: string;
	/** In a flow run: the life it ran in, counting from 1. */
	life?: number;
	/** In a flow run: every visit it ran, in the order they ended. */
	visits?: string[];
};

/** One visit of a flow run: a node's, once, in one life. */
export type VisitUsage = {
	/** `deliver#2/work[1]/code`. */
	path: string;
	/** The node's address, without iterations: `deliver/work/code`. */
	node: string;
	kind: string;
	/** The agent an `agent` visit ran. */
	agent?: string;
	/** The subagent it ran on, the one a `subagents` entry names. */
	subagent?: string;
	life: number;
	ok: boolean;
	wallMs: number;
	/** The delta of pi's cumulative stats over the visit, every nested visit included. */
	usage: Usage;
};

/** Every visit of one node address, added up. */
export type NodeUsage = {
	node: string;
	visits: number;
	/** The sum of its visits', which may overlap when they ran together. */
	wallMs: number;
	usage: Usage;
};

/** One life of a flow run: its first start, or a resume. */
export type LifeUsage = {
	/** When it started, ISO 8601. */
	startedAt: string;
	wallMs: number;
	usage: Usage;
	/** How it ended. A life killed before its end was `interrupted`. */
	end: "ok" | "failed" | "interrupted";
	/**
	 * Rebuilt from the journal, because it never wrote its own `usage.json`:
	 * what its ended visits cost, and nothing of a turn cut mid-way or of its
	 * subagents.
	 */
	partial?: true;
};

/** The sum over a whole run, and how many subagents it was spread over. */
export type UsageTotal = Usage & {
	/** Subagents in the run, failures included. */
	subagents: number;
	/** Those that ended with `ok: false`. Counted apart: `2/3 done` hides a crash. */
	failed: number;
};

/** The whole `usage.json` document. */
export type UsageReport = {
	/** When the report was written, ISO 8601. The run's own timestamp is the directory. */
	generatedAt: string;
	/** Wall time of the run itself, not the sum of the subagents. */
	wallMs: number;
	/** One entry per subagent, in tree order: a child follows the parent it hangs under. */
	subagents: UsageReportEntry[];
	/** The sum over every subagent - failures included, because they cost too. Its `wallMs` is the run's. */
	total: UsageTotal;
	/** Busy time over wall time: the parallelism actually achieved. */
	parallelism: number;
	/** Where each transcript landed, and why one is missing when it is. */
	exports?: SessionExport[];
	/** In a flow run: every visit of every life, each life's in plan order. */
	visits?: VisitUsage[];
	/** In a flow run: one entry per node address, in the order first visited. */
	nodes?: NodeUsage[];
	/** In a flow run with a journal: each life, whose sum `total` is. */
	lives?: LifeUsage[];
};

/**
 * Builds the report from a collected snapshot.
 *
 * A fan-out **aggregates**, it never averages: tokens and cost are sums,
 * `busyMs` is the sum of the branches, and `wallMs` is how long the run took.
 * The ratio of the last two is the only honest measure of parallelism.
 */
export function usageReport(snapshot: RunSnapshot, wallMs: number, exports?: SessionExport[]): UsageReport {
	const total = snapshot.usage;
	return {
		generatedAt: new Date().toISOString(),
		wallMs,
		subagents: treeOrder(snapshot.subagents).map((one) => ({
			id: one.id,
			agent: one.agent,
			lifetime: one.lifetime,
			model: one.model,
			status: one.status,
			ok: one.ok,
			error: one.error,
			task: one.task,
			toolCalls: one.tools.length,
			parentId: one.parentId,
			usage: one.usage,
		})),
		total: { ...total, wallMs, subagents: snapshot.subagents.length, failed: snapshot.failed },
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
		// A resume may come from another conversation: each keeps its own.
		const target = path.join(dir, `${freeName(dir, "main", [".jsonl"])}.jsonl`);
		fs.copyFileSync(sessionFile, target);
		return { id: "main", jsonl: target };
	} catch (cause) {
		return { id: "main", error: message(cause) };
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
