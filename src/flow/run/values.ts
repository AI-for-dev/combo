/**
 * What a visit can read where it stands, at run time: the lexical scope of
 * `src/flow/scope.ts`, holding values where that one holds types.
 *
 * Validation already proved every address names something readable here, so
 * the one thing a read can still meet is a node that ended without the value:
 * it failed under `on-fail: continue`, or an optional field was left out.
 */

import type { Ended } from "./ended.ts";

/**
 * What an address gave: its value, the node it went through that failed,
 * nothing, or, for `<loop>.previous` on a first iteration, nothing to hand on.
 */
export type Reading =
	| { readonly kind: "value"; readonly value: unknown }
	| { readonly kind: "failed"; readonly ended: Ended & { ok: false } }
	| { readonly kind: "absent"; readonly message: string }
	| { readonly kind: "first" };

/** One level of run-time scope. A child starts with everything its parent could read. */
export class Values {
	/** What is read whole by name: `input`, `item`, and a loop's or a map's own id inside it. */
	private readonly lent: Map<string, unknown>;
	/** The nodes that ended, by id. */
	private readonly nodes: Map<string, Ended>;
	/** The loops whose iteration here is their first, so `<loop>.previous` is not there yet. */
	private readonly firsts: Set<string>;

	private constructor(lent: Map<string, unknown>, nodes: Map<string, Ended>, firsts: Set<string>) {
		this.lent = lent;
		this.nodes = nodes;
		this.firsts = firsts;
	}

	/** The root sequence's scope: only `input`. */
	static root(input: unknown): Values {
		return new Values(new Map([["input", input]]), new Map(), new Set());
	}

	/** The scope of a sequence nested in this one. What ends in it is gone when it is. */
	inside(): Values {
		return new Values(new Map(this.lent), new Map(this.nodes), new Set(this.firsts));
	}

	/** Lends `name`, read whole: `item`, or a block's own id. `first` marks a loop's first iteration. */
	lend(name: string, value: unknown, first = false): this {
		this.lent.set(name, value);
		if (first) this.firsts.add(name);
		return this;
	}

	/** Records that the node `id` ended. */
	end(id: string, ended: Ended): void {
		this.nodes.set(id, ended);
	}

	/** How the node `id` ended, when it did here. */
	ended(id: string): Ended | undefined {
		return this.nodes.get(id);
	}

	/** Everything readable here, by first word, as a condition reads it. */
	all(): Record<string, unknown> {
		return Object.fromEntries([...this.lent, ...this.nodes]);
	}

	/**
	 * What `address` reads. A bare node id is its output; a deeper address
	 * reads the node as it ended, so `plan.ok` is readable after a failure and
	 * `plan.output.x` is not.
	 */
	read(address: string): Reading {
		const [root = "", ...fields] = address.split(".");
		if (this.firsts.has(root) && fields[0] === "previous") return { kind: "first" };
		const ended = this.nodes.get(root);
		if (ended !== undefined && !ended.ok && (fields.length === 0 || fields[0] === "output")) return { kind: "failed", ended };
		let value: unknown = this.lent.has(root) ? this.lent.get(root) : ended;
		if (ended !== undefined && fields.length === 0) value = ended.ok ? ended.output : undefined;
		for (const field of fields) {
			value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : undefined;
		}
		return value === undefined ? { kind: "absent", message: `\`${address}\` is absent` } : { kind: "value", value };
	}

	/** The value at `address`, or why a block that needs it cannot have it. */
	need(address: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
		const reading = this.read(address);
		if (reading.kind === "value") return { ok: true, value: reading.value };
		return { ok: false, message: reading.kind === "failed" ? `\`${address.split(".")[0]}\` failed` : `\`${address}\` is absent` };
	}
}
