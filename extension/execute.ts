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
	herdrAllFromEnv,
	findAgent,
	loadAgents as loadAgentsFromDisk,
	loop,
	orchestrate,
	reduce,
	route,
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

/**
 * Session-wide "open a herdr split for every subagent".
 *
 * A module-level switch rather than an argument threaded everywhere: it is a
 * preference about this terminal, it survives across tool calls and commands,
 * and `/herdr on` is how a user sets it without touching a single call site.
 * The environment seeds it, so a shell can be started already watching.
 */
let watchAll = herdrAllFromEnv();

/** Whether every subagent currently gets a split. */
export function watchEverything(): boolean {
	return watchAll;
}

/** Turns session-wide watching on or off. Returns the new state. */
export function watchEverythingIs(on: boolean): boolean {
	watchAll = on;
	return watchAll;
}

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
	maxTasks?: number;
	timeoutMs?: number;
	openInHerdr?: boolean;
	/** Give **every** subagent of this call a split, not only the ones that asked. */
	herdrAll?: boolean;
	scope?: string;
	export?: boolean;
	reduceWith?: string;
	candidates?: string[];
};

/** What `renderResult` needs, and nothing the LLM has to read. */
export type Details = {
	mode: string;
	subagents: SubagentSnapshot[];
	wallMs: number;
	converged?: boolean;
	iterations?: number;
	/** For route and orchestrate: what the deciding agent chose. */
	decision?: string;
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
	// `herdrAll` belongs to the reporter, not to the spawn: whether a pane opens
	// is a display decision, and the workflow runs identically either way.
	const onEvent = combineReporters(
		collector.reporter,
		deps.reporter ?? createHerdrReporter({ all: params.herdrAll || watchEverything() }),
	);

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
	let decision: string | undefined;

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
			case "route": {
				const outcome = await route({
					...shared,
					router: pick(agents, params.agent),
					destinations: stepsOf(agents, params.candidates, "candidates"),
					input: params.task ?? "",
				});
				results = [outcome];
				decision = outcome.destination?.name;
				break;
			}
			case "orchestrate": {
				const outcome = await orchestrate({
					...shared,
					planner: pick(agents, params.agent),
					workers: stepsOf(agents, params.candidates, "candidates"),
					input: params.task ?? "",
					concurrency: params.concurrency,
					maxTasks: params.maxTasks,
					reduceWith: params.reduceWith ? pick(agents, params.reduceWith, "reduceWith") : undefined,
				});
				// The plan is what a reader wants to see: who was asked what.
				decision = outcome.plan.map((step) => `${step.agent.name}: ${step.task}`).join("; ");
				results = outcome.answer ? [outcome.answer] : outcome.results;
				if (!outcome.ok && results.length === 0) results = [outcome.planning];
				break;
			}
			case "reduce": {
				const branches = await fanOut({
					...shared,
					agent: pick(agents, params.agent),
					tasks: params.tasks ?? [],
					concurrency: params.concurrency,
				});
				const answer = await reduce({
					...shared,
					agent: pick(agents, params.reduceWith, "reduceWith"),
					results: branches.results,
					input: params.task ?? "Synthesise these results into a single answer.",
				});
				// Only the synthesis goes to the model: handing it the branches as
				// well would undo the very context saving the reduction is for.
				results = [answer];
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
		details: { mode, subagents: snapshot.subagents, wallMs, converged, iterations, decision, exportDir },
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
	if (params.candidates) return "route";
	if (params.reduceWith) return "reduce";
	if (params.until || params.maxIterations) return "loop";
	if (params.steps?.length) return "chain";
	if (params.tasks?.length) return "parallel";
	return "single";
}

/** `field` names the argument that was missing: an error is read by a model too. */
function pick(agents: Agent[], name: string | undefined, field = "agent"): Agent {
	if (!name) throw new Error(`subagent: \`${field}\` is required for this mode`);
	return findAgent(agents, name);
}

function stepsOf(agents: Agent[], names: string[] | undefined, field = "steps"): Agent[] {
	if (!names?.length) throw new Error(`subagent: \`${field}\` is required for this mode`);
	return names.map((name) => findAgent(agents, name));
}

function asLifetime(value: string | undefined): Lifetime | undefined {
	return value === "task" || value === "workflow" || value === "session" ? value : undefined;
}

function asScope(value: string | undefined): AgentScope | undefined {
	return value === "user" || value === "project" || value === "both" ? value : undefined;
}
