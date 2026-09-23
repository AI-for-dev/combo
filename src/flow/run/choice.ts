/**
 * A `choice` at run time: its cases' conditions read in order, and the
 * first that holds runs, else the default, in a scope of its own. A condition
 * that cannot be read fails the node; it never counts as false.
 */

import { emptyUsage, sumUsage } from "../../usage.ts";
import { caseNames, type CheckedChoiceNode } from "../checked.ts";
import { evaluateCondition } from "../condition/index.ts";
import { failure, travelled, type Visited, type Walked } from "./ended.ts";
import type { Here, Walker } from "./walk.ts";

/** The first case whose condition holds, else the default, in a scope of its own. */
export async function visitChoice(walker: Walker, node: CheckedChoiceNode, path: string, here: Here): Promise<Visited> {
	const names = caseNames(node.cases.length);
	let chosen = node.cases.length;
	for (const [index, one] of node.cases.entries()) {
		const holds = evaluateCondition(one.when, here.values.all());
		if (!holds.ok) return { ended: failure("condition", `\`${one.when.source.trim()}\`: ${holds.message}`), usage: emptyUsage() };
		if (holds.value) {
			chosen = index;
			break;
		}
	}
	const frames = here.frames.inside(node.id, path);
	let walked: Walked;
	try {
		walked = await walker.sequence(node.cases[chosen]?.nodes ?? node.otherwise, path, { ...here, values: here.values.inside(), frames });
	} finally {
		await frames.close();
	}
	const usage = sumUsage(walked.usage, 0);
	if (walked.failed !== undefined) return { ended: travelled(walked.failed), usage, failed: walked.failed };
	const last = walked.last?.ok ? { output: walked.last.output } : {};
	return { ended: { ok: true, output: { case: names[chosen], ...last } }, usage };
}
