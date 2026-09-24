/**
 * `/flows`, with the catalogue injected: what the person is told about each
 * flow, about a broken one, and about a pipeline left where a flow now lives,
 * cut to the terminal it is drawn in.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { flowLines, planLines, showFlows, type Listing } from "../extension/commands/flows.ts";
import type { RemovedPipeline } from "../src/flow/index.ts";
import { fakeCtx } from "./fixtures/command-ctx.ts";
import { catalogueOf, flowText } from "./fixtures/flow.ts";

const look = flowText("  - id: look\n    agent: scout\n    reads: [input]\n    retry: 1", { look: "Look." }, "input: string", "look").replace("description: d", "description: look around");
const ask = flowText("  - id: go\n    agent: nobody", { go: "Go." }, "input: string", "ask");
const catalogue = catalogueOf({ look, ask });

/** A `look.md` left in the repository's `pipelines/`. */
const leftover: RemovedPipeline = {
	name: "look",
	source: "project",
	fault: { code: "pipeline-format-removed", file: "/repo/.pi/pipelines/look.md", at: "", message: "a linear pipeline, which flows replace" },
};

const texts = ({ rows }: Listing) => rows.map(({ text }) => text);
const refused = ({ rows }: Listing) => rows.filter((row) => row.refused).map(({ text }) => text);

/** `/flows <args>` drawn `width` columns wide: the lines it notified, each `<colour>` first, and how. */
function shown(args: string, width?: number, removed: RemovedPipeline[] = []): { lines: string[]; colours: string[]; type?: string } {
	const { ctx, notes } = fakeCtx();
	const tagged = { ...ctx, ui: { ...ctx.ui, theme: { fg: (colour: string, text: string) => `<${colour}>${text}` } as typeof ctx.ui.theme } };
	showFlows(args, tagged, { loadFlowCatalogue: () => catalogue, removedPipelines: () => removed }, width);
	const drawn = (notes[0]?.message ?? "").split("\n").map((line) => /^<(\w+)>(.*)$/.exec(line) ?? ["", "", line]);
	return { lines: drawn.map(([, , text]) => text as string), colours: drawn.map(([, colour]) => colour as string), type: notes[0]?.type };
}

describe("flowLines", () => {
	test("a count, then one line per flow, by name: where it comes from, its bound, its description", () => {
		const listing = flowLines(catalogueOf({ look }), []);
		assert.deepEqual(texts(listing), ["1 flow", "look  project  ≤ 2 turns · ≤ 1h  look around"]);
		assert.deepEqual(refused(listing), []);
	});

	test("a broken flow is listed beside the others, each fault under it as `file at: message`", () => {
		const listing = flowLines(catalogue, []);
		assert.deepEqual(texts(listing), [
			"1 flow, 1 file refused",
			"ask   project  broken",
			"  flows/ask.md go.agent: `nobody` is unknown; the agents are scout, planner, reviewer, synthesiser",
			"look  project  ≤ 2 turns · ≤ 1h  look around",
		]);
		assert.deepEqual(refused(listing), texts(listing).slice(1, 3));
	});

	test("a pipeline left over is refused, beside the flow that takes its name", () => {
		const listing = flowLines(catalogueOf({ look }), [leftover]);
		assert.deepEqual(texts(listing), [
			"1 flow, 1 file refused",
			"look  project  ≤ 2 turns · ≤ 1h  look around",
			"look  project  broken",
			"  /repo/.pi/pipelines/look.md: a linear pipeline, which flows replace",
		]);
		assert.deepEqual(refused(listing), texts(listing).slice(2));
	});
});

describe("planLines", () => {
	test("a flow's plan, as the plan renders it", () => {
		const listing = planLines("look", catalogue, []);
		assert.equal(texts(listing)[0], "look · flows/look.md · input string · ≤ 2 turns · ≤ 1h");
		assert.match(texts(listing)[1] ?? "", /^○ look · agent scout \(agents\/scout\.md\) · reads input · retry 1/);
		assert.deepEqual(refused(listing), []);
	});

	test("a broken flow gives its faults instead", () => {
		const listing = planLines("ask", catalogue, []);
		assert.equal(texts(listing)[0], "ask  broken");
		assert.match(texts(listing)[1] ?? "", /^ {2}flows\/ask\.md go\.agent: `nobody` is unknown/);
		assert.deepEqual(refused(listing), texts(listing));
	});

	test("an unknown name says which flows there are", () => {
		assert.deepEqual(texts(planLines("lok", catalogue, [])), ["lok  broken", "  `lok` is unknown; did you mean `look`?"]);
	});

	test("a pipeline left under the name follows the plan, since it may be what was meant", () => {
		const listing = planLines("look", catalogue, [leftover]);
		assert.deepEqual(texts(listing).slice(-3), ["", "look  project  broken", "  /repo/.pi/pipelines/look.md: a linear pipeline, which flows replace"]);
		assert.deepEqual(refused(listing), texts(listing).slice(-2));
	});
});

describe("/flows", () => {
	test("a refused file's lines read as a warning, the rest as the listing, the working directory left out of its paths", () => {
		const { lines, colours, type } = shown("", undefined, [leftover]);
		assert.equal(lines.at(-1), "  .pi/pipelines/look.md: a linear pipeline, which flows replace");
		assert.deepEqual(colours, ["dim", "warning", "warning", "dim", "warning", "warning"]);
		assert.equal(type, "info");
	});

	test("with a name, prints that flow's plan", () => {
		const { lines, type } = shown(" look ");
		assert.match(lines[0] ?? "", /^look · flows\/look\.md/);
		assert.equal(type, "info");
	});

	test("a description left fewer columns than it reads in goes on under its line, whole", () => {
		const { lines } = shown("", 42);
		assert.deepEqual(lines.slice(-2), ["look  project  ≤ 2 turns · ≤ 1h", "    look around"]);
	});

	test("a plan line goes on under its own text, cut after a whole fact", () => {
		const { lines } = shown("look", 60);
		assert.deepEqual(lines.slice(1), ["○ look · agent scout (agents/scout.md) · reads input ·", "  retry 1 · timeout 30m by default · ≤ 2 turns · ≤ 1h"]);
	});

	test("a bound is not cut between its turns and its time", () => {
		const { lines } = shown("look", 100);
		assert.deepEqual(lines.slice(1), ["○ look · agent scout (agents/scout.md) · reads input · retry 1 · timeout 30m by default ·", "  ≤ 2 turns · ≤ 1h"]);
	});

	test("asks for the flows and the pipelines of the user and the repository both", () => {
		const { ctx } = fakeCtx();
		const asked: unknown[] = [];
		showFlows("", ctx, {
			loadFlowCatalogue: (options) => (asked.push(options), catalogue),
			removedPipelines: (options) => (asked.push(options), []),
		});
		assert.deepEqual(asked, [
			{ cwd: "/repo", scope: "both", builtin: true },
			{ cwd: "/repo", scope: "both" },
		]);
	});
});
