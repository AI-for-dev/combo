/**
 * The pi extension: `subagent` as a tool the model can call, rendered live.
 *
 * Everything here is a thin shell over the library. Structural decision #2 says
 * a feature must work from a script before it is exposed in the TUI, so this
 * file owns no logic - it maps tool arguments onto combinators, and draws what
 * `createTuiCollector` collected.
 *
 * Install with:
 *   ln -s <repo>/extension/index.ts ~/.pi/agent/extensions/pi-subagent.ts
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getMarkdownTheme,
	keyHint,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { collapsedLine, formatToolCall, formatUsage, statusIcon, summaryTable } from "../src/index.ts";
import { executeSubagent, inferMode, type Details, type Params } from "./execute.ts";

/** How many tool lines the collapsed view shows before it starts eliding. */
const COLLAPSED_TOOLS = 3;

const Schema = Type.Object({
	mode: Type.Optional(
		Type.String({
			description: 'One of "single", "chain", "parallel", "loop". Inferred from the other fields when omitted.',
		}),
	),
	agent: Type.Optional(Type.String({ description: "Agent name, for single and parallel modes." })),
	task: Type.Optional(Type.String({ description: "The task, for single and chain and loop modes." })),
	tasks: Type.Optional(Type.Array(Type.String(), { description: "Independent tasks to run in parallel." })),
	steps: Type.Optional(Type.Array(Type.String(), { description: "Agent names to run in order, for chain and loop." })),
	lifetime: Type.Optional(
		Type.String({
			description: '"task" (default, fresh each time) or "workflow" (subagents remember previous turns).',
		}),
	),
	concurrency: Type.Optional(Type.Number({ description: "Parallel branches at once. Default 4." })),
	until: Type.Optional(Type.String({ description: "Loop stops when the last output contains this text." })),
	maxIterations: Type.Optional(Type.Number({ description: "Loop iteration cap. Default 5." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Deadline per turn. No default; set it for long tasks." })),
	openInHerdr: Type.Optional(Type.Boolean({ description: "Give each subagent its own herdr split." })),
	scope: Type.Optional(Type.String({ description: '"user" (default), "project" or "both".' })),
	export: Type.Optional(
		Type.Boolean({
			description: "Write every subagent's transcript and a usage.json into runs/<timestamp>/.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to isolated subagents and compose them.",
			"Modes: single (agent + task), parallel (agent + tasks), chain (steps + task),",
			"loop (steps + task + until, iterates until the last output contains `until`).",
			'Set lifetime: "workflow" when the subagents should remember previous turns.',
			`Agents come from ${getAgentDir()}/agents by default;`,
			`set scope: "project" or "both" to also load ${CONFIG_DIR_NAME}/agents from the repository.`,
			"Set export: true to keep the transcripts and the measurements of the run on disk.",
		].join(" "),
		promptSnippet: "Delegate work to isolated subagents (single, parallel, chain, loop)",
		promptGuidelines: [
			"Use subagent when a task is self-contained and would otherwise flood this context.",
			'Use subagent with lifetime: "workflow" for a coding/review loop, so the reviewer remembers its remarks.',
		],
		parameters: Schema,

		// The body lives in `execute.ts`, where every dependency is injectable
		// and therefore testable; this only hands pi's context over.
		execute(_toolCallId, params: Params, signal, onUpdate, ctx) {
			return executeSubagent(params, {
				cwd: ctx.cwd,
				signal,
				onUpdate,
				ui: ctx.ui,
				// Only this level knows where pi keeps the parent session.
				mainSessionFile: ctx.sessionManager?.getSessionFile(),
			});
		},

		renderCall(args: Params, theme: Theme, context) {
			// Reuse the same Text instance across frames instead of rebuilding
			// the tree; the row can redraw many times per second.
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const mode = inferMode(args);

			let line = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", mode);
			const who = args.agent ?? args.steps?.join(" → ");
			if (who) line += theme.fg("muted", ` ${who}`);
			if (args.lifetime === "workflow") line += theme.fg("muted", " [workflow]");
			if (args.openInHerdr) line += theme.fg("muted", " [herdr]");
			if (args.export) line += theme.fg("muted", " [export]");

			const what = args.task ?? args.tasks?.[0];
			if (what) line += `\n  ${theme.fg("dim", truncate(what, 70))}`;
			if (args.tasks && args.tasks.length > 1) {
				line += theme.fg("muted", ` (+${args.tasks.length - 1} more)`);
			}

			text.setText(line);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme: Theme, _context) {
			if (isPartial) {
				const text = result.content?.[0];
				const progress = text?.type === "text" ? text.text : "working…";
				return new Text(theme.fg("muted", progress), 0, 0);
			}

			const details = result.details as Details | undefined;
			if (!details || details.subagents.length === 0) {
				const text = result.content?.[0];
				return new Text(text?.type === "text" ? text.text : theme.fg("muted", "(no output)"), 0, 0);
			}

			return expanded ? renderExpanded(details, theme) : renderCollapsed(details, theme);
		},
	});
}

/** One line per subagent, plus the totals. This is the default view. */
function renderCollapsed(details: Details, theme: Theme): Container {
	const container = new Container();

	for (const one of details.subagents) {
		const icon = one.ok === false ? theme.fg("error", "✗") : theme.fg("success", "✓");
		let line = `${icon} ${theme.fg("toolTitle", theme.bold(one.id))}`;
		if (one.task) line += ` ${theme.fg("dim", truncate(one.task, 50))}`;
		if (one.error) line += ` ${theme.fg("error", truncate(one.error, 40))}`;
		container.addChild(new Text(line, 0, 0));

		const shown = one.tools.slice(-COLLAPSED_TOOLS);
		const hidden = one.tools.length - shown.length;
		if (hidden > 0) container.addChild(new Text(theme.fg("muted", `    … ${hidden} earlier calls`), 0, 0));
		for (const tool of shown) {
			container.addChild(new Text(theme.fg("muted", `    ${formatToolCall(tool.name, tool.args)}`), 0, 0));
		}
	}

	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", totalLine(details)), 0, 0));
	if (details.exportDir) container.addChild(new Text(theme.fg("muted", `exported to ${details.exportDir}`), 0, 0));
	// Never hard-code "Ctrl+O": the user may have rebound it.
	container.addChild(new Text(theme.fg("muted", keyHint("app.tools.expand", "to expand")), 0, 0));
	return container;
}

/** Full tasks, every tool call, the output as Markdown, usage per subagent. */
function renderExpanded(details: Details, theme: Theme): Container {
	const container = new Container();
	const markdown = getMarkdownTheme();

	for (const [index, one] of details.subagents.entries()) {
		if (index > 0) container.addChild(new Spacer(1));

		const icon = one.ok === false ? theme.fg("error", "✗") : theme.fg("success", "✓");
		container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(one.id))}`, 0, 0));

		if (one.task) {
			container.addChild(new Text(theme.fg("muted", "─── task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", one.task), 0, 0));
		}

		if (one.tools.length > 0) {
			container.addChild(new Text(theme.fg("muted", "─── tools ───"), 0, 0));
			for (const tool of one.tools) {
				container.addChild(new Text(theme.fg("muted", formatToolCall(tool.name, tool.args)), 0, 0));
			}
		}

		if (one.error) {
			container.addChild(new Text(theme.fg("error", `Error: ${one.error}`), 0, 0));
		} else if (one.output.trim()) {
			container.addChild(new Text(theme.fg("muted", "─── output ───"), 0, 0));
			container.addChild(new Markdown(one.output.trim(), 0, 0, markdown));
		}

		container.addChild(new Text(theme.fg("dim", formatUsage(one.usage)), 0, 0));
	}

	container.addChild(new Spacer(1));
	for (const line of summaryTable({ ...snapshotOf(details) }, details.wallMs)) {
		container.addChild(new Text(theme.fg("dim", line), 0, 0));
	}
	if (details.exportDir) container.addChild(new Text(theme.fg("muted", `exported to ${details.exportDir}`), 0, 0));
	return container;
}

/** Rebuilds a `TuiSnapshot` from the details we serialised into the result. */
function snapshotOf(details: Details) {
	const subagents = details.subagents;
	const usage = subagents.reduce(
		(total, one) => ({
			...total,
			busyMs: total.busyMs + one.usage.busyMs,
			turns: total.turns + one.usage.turns,
			input: total.input + one.usage.input,
			output: total.output + one.usage.output,
			cacheRead: total.cacheRead + one.usage.cacheRead,
			cacheWrite: total.cacheWrite + one.usage.cacheWrite,
			cost: total.cost + one.usage.cost,
		}),
		{ wallMs: 0, busyMs: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);

	return {
		subagents,
		total: subagents.length,
		done: subagents.filter((one) => one.status === "done").length,
		running: 0,
		failed: subagents.filter((one) => one.ok === false).length,
		usage,
	};
}

function totalLine(details: Details): string {
	const snapshot = snapshotOf(details);
	let line = formatUsage({ ...snapshot.usage, wallMs: details.wallMs });
	if (details.iterations !== undefined) {
		line += `  ${details.iterations} iteration${details.iterations > 1 ? "s" : ""}`;
		line += details.converged ? "  converged" : "  NOT converged";
	}
	if (details.wallMs > 0 && snapshot.usage.busyMs > details.wallMs) {
		line += `  ×${(snapshot.usage.busyMs / details.wallMs).toFixed(2)}`;
	}
	return line;
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Kept so the collapsed helpers stay reachable from a script too.
export { collapsedLine, statusIcon };
