/**
 * A checked condition evaluated against the values a run holds.
 *
 * A condition that cannot be evaluated is a failure with a reason, never a
 * silent `false`: reading a node that failed, an optional field that is
 * absent, or `previous` on a first iteration would otherwise read as "not
 * yet", and a loop would spin to its cap on a question it never asked.
 *
 * `&&`, `||`, `all` and `exists` follow CEL's rule for errors: a side that
 * decides the answer wins over a side that errs, whichever comes first. So
 * `audit.ok && audit.output.approved` is `false` for a failed audit, and so is
 * `audit.output.approved && audit.ok`. Nothing here reads a clock or draws a
 * number, so the same values always give the same answer.
 */

import type { Condition } from "./compile.ts";
import type { Expr } from "./parse.ts";

/** What a condition gave: its answer, or why it has none. */
export type Evaluated = { readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly message: string };

/** Why a part could not be evaluated. A class, so no value a run holds can be mistaken for one. */
class Failure {
	readonly message: string;

	constructor(message: string) {
		this.message = message;
	}
}

/**
 * `condition` against `values`, keyed by the first word of an address as
 * `compileCondition` was given their types.
 *
 * Values are what a run holds, JSON-shaped: a field set to `undefined` is
 * absent. A value off its declared type is a failure too, rather than a guess.
 */
export function evaluateCondition(condition: Condition, values: Readonly<Record<string, unknown>>): Evaluated {
	const evaluator = new Evaluator(condition.source);
	const value = evaluator.run(condition.expr, new Map(Object.entries(values)));
	if (value instanceof Failure) return { ok: false, message: value.message };
	if (typeof value !== "boolean") return { ok: false, message: `\`${condition.source.trim()}\` gave ${JSON.stringify(value)}, not a boolean` };
	return { ok: true, value };
}

type Scope = ReadonlyMap<string, unknown>;

class Evaluator {
	private readonly source: string;

	constructor(source: string) {
		this.source = source;
	}

	run(expr: Expr, scope: Scope): unknown {
		switch (expr.kind) {
			case "literal":
				return expr.value;
			case "list": {
				const items = expr.items.map((item) => this.run(item, scope));
				return items.find((item) => item instanceof Failure) ?? items;
			}
			case "name":
				return scope.get(expr.name) ?? new Failure(`\`${expr.name}\` is absent`);
			case "select": {
				const target = this.object(expr.target, scope);
				if (target instanceof Failure) return target;
				return target[expr.field] ?? new Failure(`\`${this.text(expr)}\` is absent`);
			}
			case "has": {
				const target = this.object(expr.arg.target, scope);
				return target instanceof Failure ? target : target[expr.arg.field] !== undefined;
			}
			case "not": {
				const operand = this.typed(expr.operand, scope, "boolean");
				return operand instanceof Failure ? operand : !operand;
			}
			case "size": {
				const arg = this.run(expr.arg, scope);
				if (arg instanceof Failure) return arg;
				if (typeof arg === "string") return [...arg].length;
				return Array.isArray(arg) ? arg.length : this.off(expr.arg, "a list or a string");
			}
			case "macro":
				return this.macro(expr, scope);
			case "binary":
				return this.binary(expr, scope);
		}
	}

	private binary(expr: Expr & { kind: "binary" }, scope: Scope): unknown {
		if (expr.op === "&&" || expr.op === "||") {
			return decide(expr.op === "||", [expr.left, expr.right].map((side) => () => this.typed(side, scope, "boolean")));
		}
		const left = this.run(expr.left, scope);
		if (left instanceof Failure) return left;
		const right = this.run(expr.right, scope);
		if (right instanceof Failure) return right;
		switch (expr.op) {
			case "==":
				return left === right;
			case "!=":
				return left !== right;
			case "in":
				return Array.isArray(right) ? right.includes(left) : this.off(expr.right, "a list");
			default: {
				const comparable = (typeof left === "number" || typeof left === "string") && typeof left === typeof right;
				if (!comparable) return this.off(expr, "two numbers or two strings");
				const [l, r] = [left, right] as [number, number];
				return expr.op === "<" ? l < r : expr.op === "<=" ? l <= r : expr.op === ">" ? l > r : l >= r;
			}
		}
	}

	private macro(expr: Expr & { kind: "macro" }, scope: Scope): unknown {
		const target = this.run(expr.target, scope);
		if (target instanceof Failure) return target;
		if (!Array.isArray(target)) return this.off(expr.target, "a list");
		const inner = (item: unknown) => () => this.typed(expr.body, new Map([...scope, [expr.variable, item]]), "boolean");
		return decide(expr.macro === "exists", target.map(inner));
	}

	private object(expr: Expr, scope: Scope): Record<string, unknown> | Failure {
		const value = this.run(expr, scope);
		if (value instanceof Failure) return value;
		const plain = typeof value === "object" && value !== null && !Array.isArray(value);
		return plain ? (value as Record<string, unknown>) : this.off(expr, "an object");
	}

	private typed(expr: Expr, scope: Scope, type: "boolean"): boolean | Failure {
		const value = this.run(expr, scope);
		if (value instanceof Failure || typeof value === type) return value as boolean | Failure;
		return this.off(expr, `a ${type}`);
	}

	private off(expr: Expr, wanted: string): Failure {
		return new Failure(`\`${this.text(expr)}\` is not ${wanted}`);
	}

	private text(expr: Expr): string {
		return this.source.slice(expr.start, expr.end);
	}
}

/**
 * CEL's `||` (or `exists` when `decisive` is `true`) and `&&` (`all`, when
 * `false`): the first side equal to `decisive` answers, a failure only when no
 * side does. A side after a failure is still evaluated, since it may decide.
 */
function decide(decisive: boolean, sides: readonly (() => boolean | Failure)[]): boolean | Failure {
	let failure: Failure | undefined;
	for (const side of sides) {
		const value = side();
		if (value === decisive) return decisive;
		if (value instanceof Failure) failure ??= value;
	}
	return failure ?? !decisive;
}
