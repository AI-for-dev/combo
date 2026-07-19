/**
 * The body of the `subagent` tool: argument → combinator → result.
 *
 * It lives apart from `index.ts` for one reason: **everything it touches is
 * injectable**. Loading the agents, spawning, the herdr reporter and the widget
 * surface all arrive as parameters, so the path that wires the reporters and
 * calls the combinators can be tested offline - like the combinators
 * themselves. The three bugs that reached the user through this path (an
 * `undefined` model API, a herdr reporter nobody subscribed, an `openInHerdr`
 * silently dropped) were all invisible to a green suite because this code had
 * no seam.
 *
 * `index.ts` keeps what genuinely needs a terminal: the renderers.
 */

import {
	chain,
	combineReporters,
	copyMainSession,
	createRunDir,
	createHerdrReporter,
	createTuiCollector,
	fanOut,
	findAgent,
	loadAgents as loadAgentsFromDisk,
	loop,
	progressLine,
	usageReport,
	widgetRows,
	writeUsageReport,
	type Agent,
	type AgentScope,
	type EventListener,
	type Lifetime,
	type Result,
	type SpawnFn,
	type SubagentSnapshot,
	type TuiSnapshot,
} from "../src/index.ts";

/** Key for the widget that lives above the prompt while subagents work. */
export const WIDGET = "pi-subagent";

/** How often the widget repaints while subagents are working, in ms. */
const TICK_MS = 250;

/** The arguments the model sends. Every field optional: the mode is inferred. */
export type Params = {
	mode?: string;
	agent?: string;
	task?: string;
	tasks?: string[];
	steps?: string[];
	lifetime?: string;
	concurrency?: number;
	until?: string;
	maxIterations?: number;
	timeoutMs?: number;
	openInHerdr?: boolean;
	scope?: string;
	export?: boolean;
};

/** What `renderResult` needs, and nothing the LLM has to read. */
export type Details = {
	mode: string;
	subagents: SubagentSnapshot[];
	wallMs: number;
	converged?: boolean;
	iterations?: number;
	/** Where the run was exported, when one was asked for. */
	exportDir?: string;
};

/** The colour subset of pi's `Theme` the widget needs. */
export type WidgetTheme = { fg(colour: string, text: string): string };

/** The slice of `ctx.ui` the tool uses; a test passes a double. */
export type ToolUi = {
	theme: WidgetTheme;
	setWidget(key: string, lines: string[] | undefined): void;
};

export type ToolUpdate = { content: { type: "text"; text: string }[]; details: undefined };

export type ToolOutput = {
	content: { type: "text"; text: string }[];
	details: Details;
};

/** Everything the tool body reaches for. Defaults are the real thing. */
export type ExecuteDeps = {
	cwd?: string;
	signal?: AbortSignal;
	onUpdate?: (update: ToolUpdate) => void;
	ui?: ToolUi;
	/** Defaults to reading the agent directories from disk. */
	loadAgents?: (options: { cwd?: string; scope?: AgentScope }) => Agent[];
	/** Defaults to the real `spawn`, through the combinators. */
	spawn?: SpawnFn;
	/**
	 * A second observer beside the TUI collector. Defaults to the herdr
	 * reporter, which is `undefined` unless pi itself runs inside herdr.
	 */
	reporter?: EventListener;
	/** Widget repaint period. `0` disables the timer - tests want that. */
	tickMs?: number;
	/** Where an export lands. Defaults to a fresh `runs/<timestamp>/`. */
	runDir?: () => string;
	/**
	 * The parent session's JSONL, from `ctx.sessionManager.getSessionFile()`.
	 *
	 * An orchestration export that lost the parent session would be half a
	 * story - and the extension is the only place that knows this path.
	 */
	mainSessionFile?: string;
};

/**
 * Runs one `subagent` tool call.
 *
 * Never throws for a workflow failure: a failed subagent comes back as a
 * `Result` with `ok: false`. It does throw for a caller error - an unknown
 * agent, a missing `steps` - because that is a programming mistake, not a
 * result.
 */
export async function executeSubagent(params: Params, deps: ExecuteDeps = {}): Promise<ToolOutput> {
	const collector = createTuiCollector();
	const agents = (deps.loadAgents ?? loadAgentsFromDisk)({ cwd: deps.cwd, scope: asScope(params.scope) });
	const mode = inferMode(params);

	// A dot per subagent, right above the prompt, for as long as they work.
	// The tool row keeps the full record, so this stays minimal.
	const ui = deps.ui;
	const paint = () => {
		if (!ui) return;
		ui.setWidget(WIDGET, paintWidget(collector.snapshot(), ui.theme));
	};

	// Streaming: the row redraws as the subagents work, rather than sitting on
	// an opaque spinner until the very end.
	collector.onChange(() => {
		deps.onUpdate?.({ content: [{ type: "text", text: progressLine(collector.snapshot()) }], details: undefined });
		paint();
	});

	// Events alone are not enough: a subagent that thinks for twenty seconds
	// without calling a tool emits nothing, and a frozen clock looks like a
	// hung agent.
	const tickMs = deps.tickMs ?? TICK_MS;
	const tick = tickMs > 0 ? setInterval(paint, tickMs) : undefined;
	tick?.unref?.();

	// Two observers, one stream. The TUI collector always listens; the herdr
	// reporter joins only when pi itself runs inside herdr. Forgetting this
	// line is what once let `openInHerdr` reach the spawn event with nobody
	// listening.
	const onEvent = combineReporters(collector.reporter, deps.reporter ?? createHerdrReporter());

	// The directory is created up front: subagents export themselves as they
	// close, so it has to exist before the first one finishes.
	const exportDir = params.export ? (deps.runDir ?? createRunDir)() : undefined;

	const shared = {
		lifetime: asLifetime(params.lifetime),
		exportDir,
		signal: deps.signal,
		timeoutMs: params.timeoutMs,
		openInHerdr: params.openInHerdr,
		cwd: deps.cwd,
		spawn: deps.spawn,
		onEvent,
	};

	const startedAt = performance.now();
	let results: Result[] = [];
	let converged: boolean | undefined;
	let iterations: number | undefined;

	// The widget must go even when the workflow throws - an unknown agent name,
	// for one - or a dead row of dots sits above the prompt forever.
	try {
		switch (mode) {
			case "parallel": {
				const tasks = params.tasks ?? [];
				const outcome = await fanOut({ ...shared, agent: pick(agents, params.agent), tasks, concurrency: params.concurrency });
				results = outcome.results;
				break;
			}
			case "chain": {
				const outcome = await chain({ ...shared, steps: stepsOf(agents, params.steps), input: params.task ?? "" });
				results = outcome.steps;
				break;
			}
			case "loop": {
				const needle = params.until;
				const outcome = await loop({
					...shared,
					steps: stepsOf(agents, params.steps),
					input: params.task ?? "",
					until: needle ? (step) => step.output.includes(needle) : undefined,
					maxIterations: params.maxIterations,
				});
				results = outcome.steps;
				converged = outcome.converged;
				iterations = outcome.iterations;
				break;
			}
			default: {
				const outcome = await fanOut({ ...shared, agent: pick(agents, params.agent), tasks: [params.task ?? ""] });
				results = outcome.results;
				break;
			}
		}
	} finally {
		if (tick) clearInterval(tick);
		// The widget lives only while the work does: the summary is one line up,
		// in the tool row, and nothing should pile up above the prompt between
		// two requests.
		ui?.setWidget(WIDGET, undefined);
		// In the `finally` on purpose: a run that was cancelled, or that died on
		// an unknown agent, still has work worth keeping. The subagents' own
		// transcripts landed as they closed; this adds what only we can produce.
		if (exportDir) writeRunReport(exportDir, collector.snapshot(), performance.now() - startedAt, deps.mainSessionFile);
	}

	const wallMs = performance.now() - startedAt;
	const snapshot = collector.snapshot();

	return {
		// What the model reads: the outputs, not the chrome.
		content: [{ type: "text", text: textForModel(results, converged, iterations) }],
		details: { mode, subagents: snapshot.subagents, wallMs, converged, iterations, exportDir },
	};
}

/**
 * Writes the two artefacts only this level can write: the parent session's
 * JSONL, and `usage.json`.
 *
 * Swallows its own failures - a full disk must not turn a finished workflow
 * into an error the model has to reason about.
 */
function writeRunReport(dir: string, snapshot: TuiSnapshot, wallMs: number, mainSessionFile?: string): void {
	try {
		const main = copyMainSession(mainSessionFile, dir);
		writeUsageReport(dir, usageReport(snapshot, wallMs, [main]));
	} catch {
		// an export is an observer of the run, never a participant
	}
}

/**
 * Paints the dots that sit above the prompt.
 *
 * The lines themselves come from `widgetRows`, which knows nothing about
 * colour; this only applies the theme. Keeping the two apart is what lets the
 * layout be tested without a terminal.
 */
export function paintWidget(snapshot: Parameters<typeof widgetRows>[0], theme: WidgetTheme): string[] {
	return widgetRows(snapshot).map((row) => {
		if (row.kind === "detail") return `  ${theme.fg("dim", row.text)}`;

		const colour =
			row.status === "failed" ? "error" : row.status === "done" ? "success" : row.status === "blocked" ? "warning" : "accent";
		const dot = theme.fg(colour, row.icon);
		// The id carries the weight; the activity is deliberately quiet.
		return `${dot} ${theme.fg("toolTitle", row.id)}  ${theme.fg("muted", row.activity)}`;
	});
}

/** What the model gets back: the outputs, plainly labelled. */
export function textForModel(results: Result[], converged?: boolean, iterations?: number): string {
	if (results.length === 0) return "(no subagent ran)";

	const parts = results.map((result) =>
		result.ok ? `## ${result.agent}\n${result.output}` : `## ${result.agent} (failed)\n${result.error ?? "unknown error"}`,
	);
	if (converged !== undefined) {
		parts.push(converged ? `\n(converged after ${iterations} iteration(s))` : `\n(did NOT converge after ${iterations} iteration(s))`);
	}
	return parts.join("\n\n");
}

/** Infers the mode from what was actually provided. */
export function inferMode(params: Params): string {
	if (params.mode) return params.mode;
	if (params.until || params.maxIterations) return "loop";
	if (params.steps?.length) return "chain";
	if (params.tasks?.length) return "parallel";
	return "single";
}

function pick(agents: Agent[], name: string | undefined): Agent {
	if (!name) throw new Error("subagent: `agent` is required for single and parallel modes");
	return findAgent(agents, name);
}

function stepsOf(agents: Agent[], names: string[] | undefined): Agent[] {
	if (!names?.length) throw new Error("subagent: `steps` is required for chain and loop modes");
	return names.map((name) => findAgent(agents, name));
}

function asLifetime(value: string | undefined): Lifetime | undefined {
	return value === "task" || value === "workflow" || value === "session" ? value : undefined;
}

function asScope(value: string | undefined): AgentScope | undefined {
	return value === "user" || value === "project" || value === "both" ? value : undefined;
}
