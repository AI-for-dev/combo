/**
 * The `subagent` tool's `flow` mode, on real run directories and fake
 * sessions: what the model reads back, what it is refused before anything
 * runs, and a question card put during the turn.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { executeSubagent, type ExecuteDeps } from "../extension/execute.ts";
import type { Params } from "../extension/params.ts";
import { plainDirectory } from "./fixtures/repo.ts";
import { catalogueOf, flowSpawn, flowText, type FlowTurn } from "./fixtures/flow.ts";
import { testTheme } from "./fixtures/theme.ts";

initTheme();

/** Two agents one after the other: the second reads what the first found. */
const TWO = flowText("  - id: look\n    agent: scout\n    reads: [input]\n  - id: answer\n    agent: synthesiser\n    reads: [input, look]", { look: "Look.", answer: "Answer." }, "input: string", "two");
/** A question with no default, then an agent reading its answer. */
const ASKS = flowText('  - id: sure\n    ask: "Go on?"\n    confirm: true\n  - id: answer\n    agent: synthesiser\n    reads: [input, sure]', { answer: "Answer." }, "input: string", "asks");

/** The tool called with `params` in a fresh directory, its subagents playing `turns`, its cards answered `picked`. */
function call(params: Params, turns: FlowTurn[][] = [], over: { hasUI?: boolean; picked?: string } = {}) {
	const cwd = plainDirectory();
	const { spawn, created, requested } = flowSpawn(turns);
	const cards: string[] = [];
	/** The widget as drawn while each card was up. */
	const behind: string[] = [];
	let widget: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
	const theme = testTheme();
	const deps: ExecuteDeps = {
		cwd,
		hasUI: over.hasUI ?? true,
		ui: {
			theme,
			setWidget: (_key: string, drawn: typeof widget) => void (widget = drawn),
			async custom<T>(factory: (tui: unknown, theme: never, keybindings: unknown, done: (result: T) => void) => unknown): Promise<T> {
				const card = factory({ requestRender: () => {} }, theme as never, {}, () => {}) as { render(width: number): string[] };
				cards.push(card.render(80).join("\n"));
				behind.push(widget?.(undefined, theme).render(120).join("\n") ?? "");
				return over.picked as T;
			},
			async input() {
				return undefined;
			},
		} as ExecuteDeps["ui"],
		loadFlowCatalogue: () => ({ ...catalogueOf({ two: TWO, asks: ASKS }), cwd }),
		spawn,
		reporter: () => {},
		runDir: () => path.join(cwd, "runs", "run-1"),
		tickMs: 0,
	};
	const run = () => executeSubagent(params, deps);
	return { run, cwd, cards, behind, created, requested };
}

const answered = (text: string): FlowTurn[] => [{ text }];

describe("subagent, flow mode", () => {
	test("runs the flow on the task in a run directory, and the model reads its answer and where it ran", async () => {
		const { run, cwd, requested } = call({ flow: "two", task: "where is the journal written?", model: "local/one" }, [answered("src/flow/run/journal.ts"), answered("In journal.ts.")]);
		const output = await run();

		assert.equal(output.content[0]?.text, "In journal.ts.\n\nok · runs/run-1");
		assert.deepEqual(requested.map((one) => one.options.model), ["local/one", "local/one"]);
		for (const file of ["snapshot.json", "journal.jsonl", "usage.json"]) assert.ok(fs.existsSync(path.join(cwd, "runs", "run-1", file)), file);
		assert.equal(output.details.mode, "flow");
		assert.equal(output.details.runDir, path.join(cwd, "runs", "run-1"));
		assert.equal(output.details.live?.summary.state, "done");
	});

	test("a failed run gives the path /run resume takes, and where it would pick up", async () => {
		const { run } = call({ flow: "two", task: "q" }, [answered("found"), [{ stopReason: "error", text: "" }]]);
		assert.match((await run()).content[0]?.text ?? "", /^failed at answer: provider: .* · runs\/run-1 · \/run resume runs\/run-1 picks it up at answer$/);
	});

	test("a question is put during the turn, through the terminal's card, and its answer read on", async () => {
		const { run, cards, behind, created } = call({ flow: "asks", task: "tidy up" }, [answered("Going on.")], { picked: "yes" });
		const output = await run();

		assert.equal(cards.length, 1);
		assert.match(cards[0] ?? "", /Go on\?/);
		assert.match(behind[0] ?? "", /sure/, "the plan is still drawn behind the card");
		assert.doesNotMatch(behind[0] ?? "", /esc stops everything/, "the card holds esc, and the widget does not offer it");
		assert.match(created[0]?.prompts[0] ?? "", /## sure\n\n```json\n\{\n\s*"yes": true\n\}/);
		assert.match(output.content[0]?.text ?? "", /^Going on\.\n\nok · runs\/run-1$/);
	});

	test("with nobody there, a question nobody can leave unanswered refuses the call before anything runs", async () => {
		const { run, requested, cwd } = call({ flow: "asks", task: "tidy up" }, [], { hasUI: false });
		await assert.rejects(run(), /subagent: `asks` cannot run here\n.*sure\.ask: this run is launched with nobody there/);
		assert.equal(requested.length, 0);
		assert.ok(!fs.existsSync(path.join(cwd, "runs")));
	});

	test("a composition field beside `flow` is refused, by name, rather than ignored", async () => {
		const cases: [Params, RegExp][] = [
			[{ flow: "two", task: "q", steps: ["scout"], until: "LGTM" }, /takes only `task`, `model`, `timeoutMs`, `scope`, `herdrAll` beside it - drop `steps`, `until`$/],
			[{ mode: "chain", flow: "two", task: "q" }, /drop `mode`$/],
			[{ flow: "two", task: "q", lifetime: "workflow", export: true }, /drop `lifetime`, `export`$/],
			[{ mode: "flow", task: "q" }, /needs `flow`, the name of the flow to run/],
			[{ flow: "two" }, /say what `two` should work on, in `task`/],
			[{ flow: "ghost", task: "q" }, /^Error: subagent: `ghost` is unknown; the flows are two, asks$/],
		];
		for (const [params, refused] of cases) {
			const { run, requested } = call(params);
			await assert.rejects(run(), (error: Error) => (assert.match(String(error), refused), true));
			assert.equal(requested.length, 0, JSON.stringify(params));
		}
	});
});
