/**
 * The blocks that run branches and join them: `parallel`, whose branches are
 * written in the file and all start at once, and `map`, one branch per item
 * of a list frozen when it starts, and written down.
 *
 * The join waits for every branch, and a failed one stays in the block's
 * output. Each branch opens a memory scope of its own, and in a `map` a
 * ledger of its own, so no two branches share a subagent or an obligation.
 * Under `fail-fast`, the first branch to fail cuts those in flight and skips
 * those not started, which end `cancelled`. With `copies: true`, each branch
 * runs in a copy of the tree, and `copies.ts` lands their patches: each copy
 * opened, and what landing it gave, is written down too, and a resume takes
 * back the copies the journal left open.
 */

import type { GitResult } from "../../git/index.ts";
import { emptyUsage, sumUsage } from "../../usage.ts";
import { mapConcurrent } from "../../workflows/concurrent.ts";
import type { CheckedMapNode, CheckedNode, CheckedParallelNode } from "../checked.ts";
import { branchCopy, inCopy, landAll } from "./copies.ts";
import { failure, travelled, under, type Ended, type Visited, type Walked } from "./ended.ts";
import { withLedger } from "./frames.ts";
import { journaledLedger, type KeptLedger } from "./journal.ts";
import type { Values } from "./values.ts";
import type { Here, Walker } from "./walk.ts";

/** One branch of a block: where its visits are, what it runs and reads, and its ledger. */
type Branch = { readonly prefix: string; readonly nodes: readonly CheckedNode[]; readonly values: Values; readonly ledger?: KeptLedger };

/** Every branch at once, its output an object of each as it ended, by branch name. */
export async function visitParallel(walker: Walker, node: CheckedParallelNode, path: string, here: Here): Promise<Visited> {
	const branches = node.branches.map(({ name, nodes }) => ({ prefix: under(path, name), nodes, values: here.values.inside() }));
	return join(walker, node, branches, branches.length, here, (ends) => Object.fromEntries(node.branches.map(({ name }, i) => [name, ends[i]])));
}

/**
 * Its body once per item, `concurrency` at a time, its output a list in item
 * order. A list longer than `max:` fails the map before any item runs; it is
 * never cut short. A resumed map runs over the list it froze.
 */
export async function visitMap(walker: Walker, node: CheckedMapNode, path: string, here: Here): Promise<Visited> {
	const frozen = walker.replay?.items(path);
	const listed = frozen ?? listOf(node, path, here, walker);
	if (!Array.isArray(listed)) return { ended: listed as Ended, usage: emptyUsage() };
	const items: readonly unknown[] = listed;
	const branches = items.map((item, i) => {
		const prefix = `${path}[${i + 1}]`;
		const ledger = node.ledger ? journaledLedger(walker.journal, prefix, walker.replay?.obligations(prefix)) : undefined;
		const values = here.values.inside().lend("item", item);
		if (ledger !== undefined) values.lend(node.id, withLedger({}, ledger.ledger));
		return { prefix, nodes: node.nodes, values, ledger };
	});
	return join(walker, node, branches, node.concurrency, here, (ends) => items.map((item, i) => ({ item, ...ends[i] })));
}

/** The list `node` runs over, frozen and written down; or why it cannot run. */
function listOf(node: CheckedMapNode, path: string, here: Here, walker: Walker): readonly unknown[] | Ended {
	let items: readonly unknown[];
	if ("items" in node.over) items = node.over.items;
	else {
		const read = here.values.need(node.over.from);
		if (!read.ok) return failure("condition", `\`map-from: ${node.over.from}\`: ${read.message}`);
		items = [...(read.value as unknown[])];
		if (node.max !== undefined && items.length > node.max) return failure("too-many", `\`${node.over.from}\` holds ${items.length} items, and \`max:\` is ${node.max}`);
	}
	walker.journal.append({ type: "map_items", path, items });
	return items;
}

/**
 * Runs `branches`, `concurrency` at a time, and joins them. The block fails
 * with the first branch, in order, that failed of its own; with `on-fail:
 * continue` it ends `ok: true` instead, its failed branches kept in `shape`.
 */
async function join(walker: Walker, node: CheckedParallelNode | CheckedMapNode, branches: readonly Branch[], concurrency: number, here: Here, shape: (ends: Ended[]) => unknown): Promise<Visited> {
	const cutter = new AbortController();
	const cut = node.failFast ? AbortSignal.any([here.cut, cutter.signal]) : here.cut;
	// A dry run has no tree, so its branches have no copies to make: opening one is a journal fact alone.
	const copies = node.copies && here.tree !== undefined ? walker.copies : undefined;
	const patches: GitResult<string>[] = [];
	const opened: boolean[] = [];

	const walked = await mapConcurrent(branches, concurrency, async (branch, index): Promise<Walked> => {
		const walk = async (tree: string | undefined) => {
			const frames = here.frames.inside(node.id, branch.prefix, branch.ledger);
			try {
				return await walker.sequence(branch.nodes, branch.prefix, { values: branch.values, frames, cut, tree });
			} finally {
				await frames.close();
			}
		};
		// A branch cut before it starts runs nothing, and needs no copy.
		let one: Walked;
		if (!node.copies || cut.aborted) one = await walk(here.tree);
		else {
			const { made, again } = await branchCopy(copies, here.tree, branch.prefix, walker);
			if (made === undefined || made.ok) {
				opened[index] = true;
				const copy = made?.ok ? made.value : undefined;
				if (!again) walker.journal.append({ type: "copy_opened", path: branch.prefix, ...(copy && { dir: copy.path, branch: copy.branch, base: copy.base }) });
			}
			one = made === undefined ? await walk(here.tree) : await inCopy(made, branch.prefix, walk, (patch) => (patches[index] = patch));
		}
		if (one.failed !== undefined && !cutter.signal.aborted) cutter.abort(`cut by \`fail-fast\`: ${one.failed.path} failed`);
		return one;
	});
	// Landed before the block reads its failures: what lands stays, the block failing or not.
	const landings = copies && (await landAll(copies, here.tree as string, patches, branches.map((one) => one.prefix), walker.signal));
	const landing = (index: number) => landings?.[index] ?? { landed: true };
	for (const [index, branch] of branches.entries()) {
		if (opened[index]) walker.journal.append({ type: "copy_landed", path: branch.prefix, ...landing(index) });
	}
	const usage = sumUsage(walked.flatMap((one) => one.usage), 0);
	const failures = walked.flatMap((one) => (one.failed === undefined ? [] : [one.failed]));
	const failed = failures.find((one) => one.error.kind !== "cancelled") ?? failures[0];
	if (failed !== undefined && (!node.continueOnFail || walker.signal.aborted)) return { ended: travelled(failed), usage, failed };
	const ends = walked.map((one, i): Ended => {
		const ended = one.failed !== undefined ? travelled(one.failed) : (one.last ?? { ok: true });
		return node.copies ? { ...ended, ...landing(i) } : ended;
	});
	return { ended: { ok: true, output: shape(ends) }, usage };
}
