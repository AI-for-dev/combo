/**
 * The `subagent` tool's `flow` mode: a flow a file describes, run on `task`.
 *
 * It is launched the way `/run` launches one (`commands/launch.ts`): checked
 * at both stages against this terminal, run in a run directory of its own
 * under the plan's live view, its `ask` cards shown during the model's turn
 * when somebody is there. What differs is who reads the result: the model,
 * which gets the output and the line on how the run ended, with the run
 * directory `/run resume` takes. The tool does not resume.
 *
 * The composition fields are refused beside `flow`, rather than ignored: the
 * file says what runs, and a `steps` the model believed was used is a wrong
 * answer read as a right one.
 */

import { createRunDir, loadFlowCatalogue, progressLine } from "../src/index.ts";
import { flowAnswer, launch, launchable, notLaunched } from "./commands/index.ts";
import type { Details, ExecuteDeps, ToolOutput } from "./execute.ts";
import type { Params } from "./params.ts";

/** What `flow` mode takes beside `flow` itself. `mode` is taken when it says `flow`. */
const FLOW_FIELDS: readonly (keyof Params)[] = ["mode", "flow", "task", "model", "timeoutMs", "scope", "herdrAll"];

/**
 * Runs the flow `params.flow` on `params.task`. Throws, before anything is
 * spawned, on a field the mode does not take, on no task, and on a flow
 * refused at either stage; a run that fails is a result.
 */
export async function executeFlow(params: Params, deps: ExecuteDeps): Promise<ToolOutput> {
	const { flow: name, task } = params;
	const unfit = Object.entries(params).filter(([key, value]) => value !== undefined && (!FLOW_FIELDS.includes(key as keyof Params) || (key === "mode" && value !== "flow")));
	if (unfit.length > 0) {
		const fields = FLOW_FIELDS.slice(2).map((key) => `\`${key}\``).join(", ");
		throw new Error(`subagent: \`flow\` runs a flow as its file describes it, and takes only ${fields} beside it - drop ${unfit.map(([key]) => `\`${key}\``).join(", ")}`);
	}
	if (!name) throw new Error("subagent: `flow` mode needs `flow`, the name of the flow to run");
	if (!task?.trim()) throw new Error(`subagent: say what \`${name}\` should work on, in \`task\``);

	const ctx = { cwd: deps.cwd ?? process.cwd(), hasUI: deps.hasUI ?? false, ui: deps.ui, signal: deps.signal };
	const catalogue = (deps.loadFlowCatalogue ?? loadFlowCatalogue)({ cwd: ctx.cwd, scope: params.scope, builtin: true });
	const flow = await launchable(name, catalogue, ctx);
	if (!flow.ok) throw new Error(notLaunched("subagent", name, flow, ctx.cwd));

	const runDir = (deps.runDir ?? createRunDir)();
	const result = await launch(ctx, deps, flow.run, task, {
		runDir,
		model: params.model,
		timeoutMs: params.timeoutMs,
		mainSessionFile: deps.mainSessionFile,
		view: {
			reporter: deps.reporter,
			herdrAll: params.herdrAll,
			onChange: (snapshot) => deps.onUpdate?.({ content: [{ type: "text", text: progressLine(snapshot) }], details: undefined }),
		},
	});
	const { output, end, live } = flowAnswer(ctx, flow.run.flow, runDir, result);
	const details: Details = { mode: "flow", subagents: [], wallMs: result.usage.wallMs, runDir, live, end };
	return { content: [{ type: "text", text: [output.trim(), end].filter(Boolean).join("\n\n") }], details };
}
