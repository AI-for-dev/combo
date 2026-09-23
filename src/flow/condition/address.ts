/**
 * An address, as `reads:`, `agent-from:` and the other `-from` keys write it:
 * a name, then fields (`plan.output.subtasks`).
 *
 * An address is a CEL field selection, so it is parsed and typed by the very
 * code that types a condition, and the two can never disagree on what
 * `plan.output.subtasks` names. The one difference is prose: an address may
 * name an agent's text whole, to hand it to the next agent.
 */

import type { ValueType } from "../type.ts";
import { Checker, type Readable } from "./compile.ts";
import { parse, type Expr } from "./parse.ts";
import { SyntaxFault } from "./tokens.ts";

/** Why an address was refused. */
export type AddressProblem = { readonly code: "invalid-address" | "unknown-address"; readonly message: string };

/** The type an address names, or why it names none. */
export type TypedAddress = { readonly ok: true; readonly type: ValueType } | { readonly ok: false; readonly problems: readonly AddressProblem[] };

/** The type `source` names among `readable`. */
export function typeOfAddress(source: string, readable: Readable): TypedAddress {
	const invalid = (message: string): TypedAddress => ({ ok: false, problems: [{ code: "invalid-address", message }] });
	let expr: Expr;
	try {
		expr = parse(source);
	} catch (error) {
		if (!(error instanceof SyntaxFault)) throw error;
		return invalid(error.message);
	}
	if (!isChain(expr)) return invalid(`\`${source}\` is not an address: a name, then fields, as in \`plan.output.subtasks\``);
	const checker = new Checker(source, true);
	const typed = checker.check(expr, new Map(Object.entries(readable)));
	if (typed !== undefined) return { ok: true, type: typed.type };
	const problems = checker.problems.map(({ code, message }) => ({ code: code === "condition-unknown-address" ? ("unknown-address" as const) : ("invalid-address" as const), message }));
	return { ok: false, problems };
}

function isChain(expr: Expr): boolean {
	return expr.kind === "name" || (expr.kind === "select" && isChain(expr.target));
}
