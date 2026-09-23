/**
 * A plan as text: the head line of the flow, then one line per plan line,
 * indented under the line that holds it.
 *
 * Every line starts with the glyph of a visit not made yet, the one a run
 * view draws before `●`, `✓` or `✗` replace it, so the plan reads as the
 * first frame of a run.
 */

import { showBound } from "../bounds.ts";
import type { Plan, PlanLine } from "./plan.ts";

/** What a line not visited yet is marked with. */
export const NOT_VISITED = "○";

/** `plan` as lines of text, pure. */
export function showPlan(plan: Plan): string {
	const head = [plan.flow, ...plan.facts, showBound(plan.bound)].filter((part) => part !== "").join(" · ");
	return [head, ...plan.lines.flatMap((line) => shown(line, 0))].join("\n");
}

function shown(line: PlanLine, depth: number): string[] {
	const label = line.kind === "case" ? (line.id === "default" ? "default" : `case ${line.id}`) : line.path;
	const parts = [label, ...line.facts, ...(line.bound === undefined ? [] : [showBound(line.bound)])].filter((part) => part !== "");
	return [`${"  ".repeat(depth)}${NOT_VISITED} ${parts.join(" · ")}`, ...line.lines.flatMap((one) => shown(one, depth + 1))];
}
