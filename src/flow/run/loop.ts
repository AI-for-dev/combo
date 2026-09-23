/**
 * A `loop` at run time: its body again and again, `#1` first, until its
 * condition holds, it gives up, or it reaches `max:`.
 *
 * Reaching the cap is not success: a loop that gave up or ran out fails
 * `unconverged`, unless `on-fail: continue` ends it `ok: true` with
 * `converged: false`. A body node that fails ends the loop at once, and the
 * condition never sees it. What an iteration hands the next goes through
 * `previous` (one iteration back, starting over each time the loop is
 * entered), `carry`, the ledger, and the memory scope the loop opens once for
 * all its iterations.
 */

import { createLedger } from "../../review/index.ts";
import { sumUsage, type Usage } from "../../usage.ts";
import type { CheckedLoopNode, STOPS } from "../checked.ts";
import { evaluateCondition, type Condition } from "../condition/index.ts";
import { failure, travelled, type Ended, type Visited } from "./ended.ts";
import { withLedger } from "./frames.ts";
import type { Values } from "./values.ts";
import type { Here, Walker } from "./walk.ts";

type Stop = (typeof STOPS)[number];

/** Visits `node` at `path`, its iterations at `path#1`, `path#2`... */
export async function visitLoop(walker: Walker, node: CheckedLoopNode, path: string, here: Here): Promise<Visited> {
	const usage: Usage[] = [];
	const done = (ended: Ended, visited?: Partial<Visited>): Visited => ({ ended, usage: sumUsage(usage, 0), ...visited });
	const ledger = node.ledger ? createLedger() : undefined;
	const frames = here.frames.inside(node.id, ledger);
	try {
		let carry = carried(node, "first", here.values);
		let previous: Record<string, Ended> | undefined;
		for (let n = 1; ; n++) {
			if (!carry.ok) return done(carry.ended);
			const own = withLedger({ ...(previous && { previous }), ...(node.carry && { carry: carry.value }) }, ledger);
			const values = here.values.inside().lend(node.id, own, previous === undefined);
			const walked = await walker.sequence(node.nodes, `${path}#${n}`, { ...here, values, frames });
			usage.push(...walked.usage);
			if (walked.failed !== undefined) return done(travelled(walked.failed), { failed: walked.failed });
			const last = Object.fromEntries(node.nodes.map((one) => [one.id, values.ended(one.id) as Ended]));
			const stop = stopped(node, values, n);
			if (typeof stop === "object") return done(stop);
			if (stop !== undefined) return done(ended(node, stop, n, last));
			carry = carried(node, "next", values);
			previous = last;
		}
	} finally {
		await frames.close();
	}
}

/** Why the loop stops after iteration `n`, if it does, or the condition that could not be read. */
function stopped(node: CheckedLoopNode, values: Values, n: number): Stop | Ended | undefined {
	const until = holds(node.until, values);
	if (until !== false) return until === true ? "until" : until;
	const giveUp = node.giveUp && holds(node.giveUp, values);
	if (giveUp !== undefined && giveUp !== false) return giveUp === true ? "give-up" : giveUp;
	return n >= node.max ? "cap" : undefined;
}

/** A condition read at the end of an iteration. One that cannot be read fails the loop, never counts as false. */
function holds(condition: Condition, values: Values): boolean | Ended {
	const held = evaluateCondition(condition, values.all());
	return held.ok ? held.value : failure("condition", `\`${condition.source.trim()}\`: ${held.message}`);
}

/** The value `carry.<side>` reads, none without a carry, or the failure of a loop that cannot read it. */
function carried(node: CheckedLoopNode, side: "first" | "next", values: Values): { ok: true; value?: unknown } | { ok: false; ended: Ended } {
	if (node.carry === undefined) return { ok: true };
	const address = node.carry[side];
	const read = values.need(address);
	return read.ok ? read : { ok: false, ended: failure("condition", `\`carry.${side}: ${address}\`: ${read.message}`) };
}

/** How a loop that stopped ends: converged, or not, which fails it unless `on-fail: continue`. */
function ended(node: CheckedLoopNode, stop: Stop, iterations: number, last: Record<string, Ended>): Ended {
	const output = { converged: stop === "until", stop, iterations, last };
	if (stop === "until" || node.continueOnFail) return { ok: true, output };
	const why = stop === "cap" ? `reached \`max: ${node.max}\`` : `gave up after ${iterations} iteration${iterations === 1 ? "" : "s"}`;
	return failure("unconverged", `${why} before \`${node.until.source.trim()}\` held`);
}
