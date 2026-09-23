/**
 * What a node can read where it stands: the nodes already ended in its own
 * sequence and in every enclosing one, `input` and `diff`, and what an enclosing block
 * lends it: `item` inside a `map`, and inside a loop the loop's own
 * `previous`, `carry` and `ledger`.
 *
 * Lexical, and nothing more: a block's nested nodes are readable inside it
 * and gone after it, where the block's own output stands in for them. So
 * nothing inside a sibling block is visible, and there is no way to write an
 * address that could only be resolved at run time.
 */

import { endedNode } from "./checked.ts";
import type { ValueType } from "./type.ts";

/** One level of lexical scope. A child starts with everything its parent could read. */
export class Scope {
	/** What a condition or a deeper address reads, by its first word. */
	private readonly names: Map<string, ValueType>;
	/** What a bare id reads in `reads:`: a node's output, `input`, `item`. */
	private readonly outputs: Map<string, ValueType>;
	/** The structural nodes this scope is inside, outermost first, and what each opens. */
	private readonly enclosing: readonly ({ readonly id: string } & Opens)[];

	private constructor(names: Map<string, ValueType>, outputs: Map<string, ValueType>, enclosing: Scope["enclosing"]) {
		this.names = names;
		this.outputs = outputs;
		this.enclosing = enclosing;
	}

	/** The root sequence's scope: `input`, and `diff`, the tree's changes as a text. */
	static root(input: ValueType): Scope {
		const reserved: [string, ValueType][] = [
			["input", input],
			["diff", { kind: "text" }],
		];
		return new Scope(new Map(reserved), new Map(reserved), []);
	}

	/** The scope of a sequence inside the structural node `id`. */
	inside(id: string, opens: Partial<Opens> = {}): Scope {
		const { ledger = false, copies = false } = opens;
		return new Scope(new Map(this.names), new Map(this.outputs), [...this.enclosing, { id, ledger, copies }]);
	}

	/** Lends `name` to this scope, read whole as it is: `item`. An outer one of the same name is no longer readable. */
	lend(name: string, type: ValueType): this {
		this.names.set(name, type);
		this.outputs.set(name, type);
		return this;
	}

	/** Records that the node `id` ended, with an output of type `output`. */
	end(id: string, output: ValueType): void {
		this.names.set(id, endedNode(output));
		this.outputs.set(id, output);
	}

	/** Whether `name` is readable here. */
	has(name: string): boolean {
		return this.names.has(name);
	}

	/** What `name` reads whole in `reads:`, when it is a bare name. */
	output(name: string): ValueType | undefined {
		return this.outputs.get(name);
	}

	/** Everything readable here, by first word. */
	readable(): Readonly<Record<string, ValueType>> {
		return Object.fromEntries(this.names);
	}

	/** Whether this scope is inside the structural node `id`. */
	encloses(id: string): boolean {
		return this.enclosing.some((one) => one.id === id);
	}

	/** Whether this scope is inside the structural node `id`, and that node keeps a ledger. */
	keepsLedger(id: string): boolean {
		return this.enclosing.some((one) => one.id === id && one.ledger);
	}

	/** Whether this scope is inside a `copies: true` block, where the tree is a branch's copy. */
	inCopies(): boolean {
		return this.enclosing.some((one) => one.copies);
	}

	/**
	 * Whether the memory scope `scope` (`flow` for the run) opens outside the
	 * innermost `copies: true` block around this one: its subagent would work
	 * in another tree than this branch's copy.
	 */
	outsideCopies(scope: string): boolean {
		const copies = this.enclosing.findLastIndex((one) => one.copies);
		return copies !== -1 && this.enclosing.findLastIndex((one) => one.id === scope) < copies;
	}
}

/** What a structural node opens for its sequences: a ledger, a copy of the tree per branch. */
type Opens = { readonly ledger: boolean; readonly copies: boolean };
