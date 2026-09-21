/**
 * The pi extension: `subagent` as a tool the model can call, rendered live.
 *
 * Everything here is a thin shell over the library. Structural decision #2 says
 * a feature must work from a script before it is exposed in the TUI, so this
 * file owns no logic - it maps tool arguments onto combinators, and draws what
 * `createRunPicture` folded.
 *
 * Install with:
 *   ln -s <repo>/extension/index.ts ~/.pi/agent/extensions/combo.ts
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getMarkdownTheme,
	keyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	formatToolCall,
	formatUsage,
	MAX_DEPTH,
	plural,
	snapshotFrom,
	standingOf,
	statusColour,
	statusIcon,
	summaryTable,
	treeOrder,
	truncate,
	type SubagentSnapshot,
} from "../src/index.ts";
import {
	PIPELINE_MESSAGE,
	registerAgentCommands,
	registerBuildCommand,
	registerHerdrCommand,
	registerInterviewCommand,
	registerPipelineCommands,
	registerStepCommands,
	registerStopCommand,
	registerSwarmCommand,
} from "./commands/index.ts";
import { executeSubagent, type Details } from "./execute.ts";
import { inferMode, Schema, type Params } from "./params.ts";
import { toolDeps, type PiApi } from "./pi.ts";
import { STEP_ENTRY, type StepEntry } from "./relay.ts";

/** How many tool lines the collapsed view shows before it starts eliding. */
const COLLAPSED_TOOLS = 3;

export default function (pi: PiApi) {
	// The interactive flows are commands, not tools: an interview owns the
	// terminal question by question, which a model's turn cannot.
	registerInterviewCommand(pi);
	registerBuildCommand(pi);
	registerHerdrCommand(pi);
	registerPipelineCommands(pi);
	registerAgentCommands(pi);
	registerStepCommands(pi);
	registerSwarmCommand(pi);
	registerStopCommand(pi);

	// A finished pipeline leaves its answer in the conversation. Drawn as its own
	// block, because pi hands custom messages to the model as *user* messages,
	// and a wall of synthesised Markdown looking like something the user typed is
	// the one reading that must not happen.
	pi.registerMessageRenderer(PIPELINE_MESSAGE, (message, _options, theme: Theme) => {
		const details = message.details as { pipeline?: string; steps?: string[] } | undefined;
		const container = new Container();
		const steps = details?.steps?.length ? ` · ${details.steps.join(" → ")}` : "";

		container.addChild(
			new Text(`${theme.fg("accent", "◆")} ${theme.fg("toolTitle", theme.bold(details?.pipeline ?? "pipeline"))}${theme.fg("dim", steps)}`, 0, 0),
		);
		container.addChild(new Markdown(String(message.content).trim(), 0, 0, getMarkdownTheme()));
		return container;
	});

	// A step of a hand-walked chain is an **entry**, not a message: it is drawn
	// in the transcript and stays out of the model's context, which is the whole
	// reason `/step` exists beside `/run`. The header says so, because a report
	// sitting in the transcript otherwise reads as something the session has
	// read - and the next command is chosen on that belief.
	pi.registerEntryRenderer(STEP_ENTRY, (entry, _options, theme: Theme) => {
		const data = entry.data as StepEntry;
		const container = new Container();
		const carried = data.from ? theme.fg("dim", ` ←${data.from}`) : "";

		container.addChild(
			new Text(
				`${theme.fg("accent", "◇")} ${theme.fg("toolTitle", theme.bold(data.id))}${theme.fg("muted", ` ${data.kind}`)}${carried}` +
					`  ${theme.fg("muted", plural(data.turns, "turn"))}` +
					`  ${theme.fg("warning", "outside this conversation")}${theme.fg("muted", " - /quote puts it in")}`,
				0,
				0,
			),
		);
		// Indented, because the header alone was not enough: drawn flush left and
		// full width, a step reads exactly like an answer the session gave, and
		// the one line saying otherwise is the quietest thing on the screen.
		container.addChild(new Markdown(String(data.output).trim(), 2, 0, getMarkdownTheme()));
		return container;
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to isolated subagents and compose them.",
			"Modes: single (agent + task), parallel (agent + tasks), chain (steps + task),",
			"loop (steps + task + until, iterates until the last output says `until` alone on a line),",
			"reduce (agent + tasks + reduceWith + task, fans out then synthesises into one answer),",
			"route (agent + candidates + task, the agent classifies and one candidate does the work),",
			"orchestrate (agent + candidates + task, the agent plans the split and the workers run it).",
			"With candidates and no explicit mode, route is assumed: it is the cheaper reading.",
			'Set lifetime: "workflow" when the subagents should remember previous turns.',
			`Agents come from ${getAgentDir()}/agents by default;`,
			`set scope: "project" or "both" to also load ${CONFIG_DIR_NAME}/agents from the repository.`,
			"An agent whose own definition names the subagent tool may split its task further;",
			`that goes ${MAX_DEPTH} levels deep unless maxDepth says otherwise, and nobody else can delegate at all.`,
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
			return executeSubagent(params, toolDeps(ctx, signal, onUpdate));
		},

		renderCall(args: Params, theme: Theme, context) {
			// Reuse the same Text instance across frames instead of rebuilding
			// the tree; the row can redraw many times per second.
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const mode = inferMode(args);

			let line = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", mode);
			const who = args.agent ?? args.steps?.join(" → ") ?? args.candidates?.join(", ");
			if (who) line += theme.fg("muted", ` ${who}`);
			if (args.lifetime === "workflow") line += theme.fg("muted", " [workflow]");
			if (args.maxDepth !== undefined) line += theme.fg("muted", ` [≤${args.maxDepth} deep]`);
		if (args.model) line += theme.fg("muted", ` [${args.model}]`);
			if (args.openInHerdr || args.herdrAll) line += theme.fg("muted", args.herdrAll ? " [herdr:all]" : " [herdr]");
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

	for (const one of treeOrder(details.subagents)) {
		// A subagent that was delegated sits under the one that asked for it:
		// three scouts read as an explorer's split rather than as five peers.
		const indent = "  ".repeat(one.depth);
		let line = `${indent}${drawnIcon(one, theme)} ${theme.fg("toolTitle", theme.bold(one.id))}`;
		if (one.task) line += ` ${theme.fg("dim", truncate(one.task, 50))}`;
		if (one.error) line += ` ${theme.fg("error", truncate(one.error, 40))}`;
		container.addChild(new Text(line, 0, 0));

		const shown = one.tools.slice(-COLLAPSED_TOOLS);
		const hidden = one.tools.length - shown.length;
		if (hidden > 0) container.addChild(new Text(theme.fg("muted", `${indent}    … ${hidden} earlier calls`), 0, 0));
		for (const tool of shown) {
			container.addChild(new Text(theme.fg("muted", `${indent}    ${formatToolCall(tool.name, tool.args)}`), 0, 0));
		}
	}

	container.addChild(new Spacer(1));
	// Who was picked, or what the plan was: without it a route reads as one
	// opaque turn followed by another.
	if (details.decision) container.addChild(new Text(theme.fg("accent", `→ ${truncate(details.decision, 70)}`), 0, 0));
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

	for (const [index, one] of treeOrder(details.subagents).entries()) {
		if (index > 0) container.addChild(new Spacer(1));

		container.addChild(new Text(`${"  ".repeat(one.depth)}${drawnIcon(one, theme)} ${theme.fg("toolTitle", theme.bold(one.id))}`, 0, 0));

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
	if (details.decision) container.addChild(new Text(theme.fg("accent", `→ ${details.decision}`), 0, 0));
	for (const line of summaryTable(snapshotFrom(details.subagents), details.wallMs)) {
		container.addChild(new Text(theme.fg("dim", line), 0, 0));
	}
	if (details.exportDir) container.addChild(new Text(theme.fg("muted", `exported to ${details.exportDir}`), 0, 0));
	return container;
}

function totalLine(details: Details): string {
	const snapshot = snapshotFrom(details.subagents);
	let line = formatUsage({ ...snapshot.usage, wallMs: details.wallMs });
	if (details.iterations !== undefined) {
		line += `  ${plural(details.iterations, "iteration")}`;
		line += details.converged ? "  converged" : "  NOT converged";
	}
	if (details.wallMs > 0 && snapshot.usage.busyMs > details.wallMs) {
		line += `  ×${(snapshot.usage.busyMs / details.wallMs).toFixed(2)}`;
	}
	return line;
}

/** The glyph for how a subagent stands, in the colour that standing is drawn in. */
function drawnIcon(one: SubagentSnapshot, theme: Theme): string {
	const standing = standingOf(one);
	return theme.fg(statusColour(standing), statusIcon(standing));
}
