/**
 * A condition checked whole against the types of what it may read, before the
 * first spawn.
 *
 * Every address must exist and be typed, the result must be a boolean and
 * compared sides must agree. Enums are strict: `"aproved"` compared with an
 * `approved | rejected` field is refused here, since at run time it would only
 * ever be `false` and the loop would spin to its cap. A string a model wrote
 * in the person's language compares to no literal at all, for the same reason:
 * `"Yes"` against a clicked `"Oui"` is silently false.
 *
 * Problems are collected, not thrown at the first: a flow is refused with
 * every fault at once. A part already refused is read no further, so one typo
 * is one problem and not the three that follow from it.
 */

import { showType, type ValueType } from "../type.ts";
import { parse, type Expr } from "./parse.ts";
import { SyntaxFault } from "./tokens.ts";

/** Why a condition was refused. Stable, so tests and the documentation's table can name them. */
export const CONDITION_CODES = ["condition-syntax", "condition-unknown-address", "condition-type", "condition-enum-value", "condition-free-string"] as const;

/** One of {@link CONDITION_CODES}. */
export type ConditionCode = (typeof CONDITION_CODES)[number];

/** One reason a condition is refused. The validator adds the file and the node. */
export type ConditionProblem = { readonly code: ConditionCode; readonly message: string };

/** What a condition may read, by the first word of its address. */
export type Readable = Readonly<Record<string, ValueType>>;

/** A condition that passed the check. Only `compileCondition` makes one, and only one can be evaluated. */
export type Condition = { readonly source: string; readonly expr: Expr; readonly [checked]: true };

declare const checked: unique symbol;

/** The outcome of compiling: a condition, or every problem found in it. */
export type Compiled = { readonly ok: true; readonly condition: Condition } | { readonly ok: false; readonly problems: readonly ConditionProblem[] };

/**
 * `source` parsed and type-checked against `readable`.
 *
 * A syntax fault is the only problem returned when there is one: a tree that
 * did not parse has nothing further to check.
 */
export function compileCondition(source: string, readable: Readable): Compiled {
	let expr: Expr;
	try {
		expr = parse(source);
	} catch (error) {
		if (!(error instanceof SyntaxFault)) throw error;
		return { ok: false, problems: [{ code: "condition-syntax", message: error.message }] };
	}
	const checker = new Checker(source, false);
	const result = checker.check(expr, new Map(Object.entries(readable)));
	if (result !== undefined && result.type.kind !== "boolean") {
		checker.problem("condition-type", `a condition is a boolean, and \`${source.trim()}\` is ${article(result.type)}`);
	}
	if (checker.problems.length > 0) return { ok: false, problems: checker.problems };
	return { ok: true, condition: { source, expr } as Condition };
}

/** A checked part: its type, and the string literals it is made of, which a strict enum is held against. */
type Typed = { readonly type: ValueType; readonly literals?: readonly string[] } | undefined;

const BOOLEAN: ValueType = { kind: "boolean" };
const NUMBER: ValueType = { kind: "number" };

/**
 * The type checker, for a condition and for an address alike.
 *
 * `acceptsText` is the one difference: an address may name an agent's prose
 * whole, which is what `reads:` hands the next agent, while a condition never
 * reads prose at all.
 */
export class Checker {
	readonly problems: ConditionProblem[] = [];
	private readonly source: string;
	private readonly acceptsText: boolean;

	constructor(source: string, acceptsText: boolean) {
		this.source = source;
		this.acceptsText = acceptsText;
	}

	problem(code: ConditionCode, message: string): undefined {
		this.problems.push({ code, message });
		return undefined;
	}

	check(expr: Expr, scope: ReadonlyMap<string, ValueType>): Typed {
		switch (expr.kind) {
			case "literal":
				if (typeof expr.value === "string") return { type: { kind: "string" }, literals: [expr.value] };
				return { type: typeof expr.value === "number" ? NUMBER : BOOLEAN };
			case "list":
				return this.list(expr, scope);
			case "name": {
				const type = scope.get(expr.name);
				if (type !== undefined) return this.typed(expr, { type });
				return this.problem("condition-unknown-address", `\`${expr.name}\` is not readable here; what is: ${[...scope.keys()].join(", ") || "nothing"}`);
			}
			case "select":
				return this.typed(expr, this.select(expr, this.check(expr.target, scope)));
			case "not":
				return this.booleans([expr.operand], scope);
			case "binary":
				return this.binary(expr, scope);
			case "size": {
				const arg = this.check(expr.arg, scope);
				if (arg === undefined) return undefined;
				if (arg.type.kind === "string" || arg.type.kind === "list") return { type: NUMBER };
				return this.problem("condition-type", `\`size()\` counts a list or a string, and \`${this.text(expr.arg)}\` is ${article(arg.type)}`);
			}
			case "has":
				return this.check(expr.arg, scope) === undefined ? undefined : { type: BOOLEAN };
			case "macro": {
				const target = this.check(expr.target, scope);
				if (target === undefined) return undefined;
				if (target.type.kind !== "list") {
					return this.problem("condition-type", `\`${expr.macro}\` walks a list, and \`${this.text(expr.target)}\` is ${article(target.type)}`);
				}
				return this.booleans([expr.body], new Map([...scope, [expr.variable, target.type.of]]));
			}
		}
	}

	/** What an address gave, unless it is prose a condition may not read. */
	private typed(expr: Expr, typed: Typed): Typed {
		if (typed === undefined || typed.type.kind !== "text" || this.acceptsText) return typed;
		return this.problem("condition-type", `\`${this.text(expr)}\` is text, written with no \`output:\` schema; a condition reads typed values only`);
	}

	private list(expr: Expr & { kind: "list" }, scope: ReadonlyMap<string, ValueType>): Typed {
		if (expr.items.length === 0) return this.problem("condition-type", "`[]`: a condition on an empty list is the same whatever the run did");
		const items = expr.items.map((item) => this.check(item, scope));
		if (items.some((item) => item === undefined)) return undefined;
		const [first, ...rest] = items as NonNullable<Typed>[];
		for (const [i, item] of rest.entries()) {
			if (!this.equatable(first as NonNullable<Typed>, item, expr.items[0] as Expr, expr.items[i + 1] as Expr)) return undefined;
		}
		const literals = items.every((item) => item?.literals !== undefined) ? items.flatMap((item) => item?.literals ?? []) : undefined;
		return { type: { kind: "list", of: (first as NonNullable<Typed>).type }, literals };
	}

	private select(expr: Expr & { kind: "select" }, target: Typed): Typed {
		if (target === undefined) return undefined;
		const path = this.text(expr.target);
		if (target.type.kind !== "object") {
			return this.problem("condition-type", `\`${path}\` is ${article(target.type)}, which has no field \`${expr.field}\``);
		}
		const field = target.type.fields[expr.field];
		if (field !== undefined) return { type: field.type };
		const names = Object.keys(target.type.fields);
		return this.problem("condition-unknown-address", `\`${path}\` has no field \`${expr.field}\`; its fields: ${names.join(", ") || "none"}`);
	}

	private binary(expr: Expr & { kind: "binary" }, scope: ReadonlyMap<string, ValueType>): Typed {
		if (expr.op === "&&" || expr.op === "||") return this.booleans([expr.left, expr.right], scope);
		const left = this.check(expr.left, scope);
		const right = this.check(expr.right, scope);
		if (left === undefined || right === undefined) return undefined;
		if (expr.op === "in") {
			if (right.type.kind !== "list") {
				return this.problem("condition-type", `\`in\` looks in a list, and \`${this.text(expr.right)}\` is ${article(right.type)}`);
			}
			const element = { type: right.type.of, literals: right.literals };
			return this.equatable(left, element, expr.left, expr.right) ? { type: BOOLEAN } : undefined;
		}
		if (expr.op === "==" || expr.op === "!=") return this.equatable(left, right, expr.left, expr.right) ? { type: BOOLEAN } : undefined;
		const ordered = (left.type.kind === "number" || left.type.kind === "string") && left.type.kind === right.type.kind;
		const free = ordered ? this.freeAgainstLiteral(left, right, expr.left, expr.right) : undefined;
		if (free !== undefined) return this.problem(...free);
		if (ordered) return { type: BOOLEAN };
		return this.problem("condition-type", `\`${expr.op}\` orders two numbers or two strings, and \`${this.text(expr)}\` compares ${article(left.type)} with ${article(right.type)}`);
	}

	private booleans(operands: readonly Expr[], scope: ReadonlyMap<string, ValueType>): Typed {
		let ok = true;
		for (const operand of operands) {
			const typed = this.check(operand, scope);
			if (typed === undefined) ok = false;
			else if (typed.type.kind !== "boolean") {
				this.problem("condition-type", `\`${this.text(operand)}\` is ${article(typed.type)}, where a boolean is needed`);
				ok = false;
			}
		}
		return ok ? { type: BOOLEAN } : undefined;
	}

	/** Whether two sides may be compared, reporting why not. An enum met by a string literal holds it to its values. */
	private equatable(a: NonNullable<Typed>, b: NonNullable<Typed>, aExpr: Expr, bExpr: Expr): boolean {
		const why = this.incomparable(a, b, aExpr, bExpr);
		if (why !== undefined) this.problem(why[0], why[1]);
		return why === undefined;
	}

	private incomparable(a: NonNullable<Typed>, b: NonNullable<Typed>, aExpr: Expr, bExpr: Expr): [ConditionCode, string] | undefined {
		const [l, r] = [this.text(aExpr), this.text(bExpr)];
		const free = this.freeAgainstLiteral(a, b, aExpr, bExpr);
		if (free !== undefined) return free;
		for (const [side, other, expr] of [[a, b, bExpr], [b, a, aExpr]] as const) {
			if (side.type.kind !== "enum" || other.literals === undefined) continue;
			const values = side.type.values;
			const outside = other.literals.filter((literal) => !values.includes(literal));
			if (outside.length > 0) {
				const quoted = outside.map((literal) => JSON.stringify(literal)).join(", ");
				return ["condition-enum-value", `\`${this.text(expr)}\`: ${quoted} is not one of ${values.join(" | ")}`];
			}
		}
		const [x, y] = [a.type, b.type];
		if ([x.kind, y.kind].some((kind) => kind === "list" || kind === "object")) {
			return ["condition-type", `\`${l}\` and \`${r}\`: only a string, a number, a boolean or an enum compares; read a field, or use \`size()\`, \`all\` or \`exists\``];
		}
		if (x.kind === "enum" && y.kind === "enum" && !x.values.some((value) => y.values.includes(value))) {
			return ["condition-type", `\`${l}\` (${showType(x)}) and \`${r}\` (${showType(y)}) share no value`];
		}
		const textual = (kind: string) => kind === "string" || kind === "enum";
		if (x.kind === y.kind || (textual(x.kind) && textual(y.kind))) return undefined;
		return ["condition-type", `\`${l}\` is ${article(x)} and \`${r}\` ${article(y)}: they never compare equal`];
	}

	/** Why a side is a string a model wrote, met by a literal of the file, when it is. */
	private freeAgainstLiteral(a: NonNullable<Typed>, b: NonNullable<Typed>, aExpr: Expr, bExpr: Expr): [ConditionCode, string] | undefined {
		for (const [side, other, expr] of [[a, b, aExpr], [b, a, bExpr]] as const) {
			if (side.type.kind !== "string" || side.type.free !== true || other.literals === undefined) continue;
			return ["condition-free-string", `\`${this.text(expr)}\` is written by a model in the person's language, so no literal compares to it: read \`answered\` or \`custom\`, or have an agent node read the answer and output an enum`];
		}
		return undefined;
	}

	private text(expr: Expr): string {
		return this.source.slice(expr.start, expr.end);
	}
}

/** `a number`, `an enum (a | b)`, `a list ([string])`: a type as a message names it. */
function article(type: ValueType): string {
	switch (type.kind) {
		case "enum":
			return `an enum (${showType(type)})`;
		case "list":
		case "object":
			return `${type.kind === "list" ? "a list" : "an object"} (${showType(type)})`;
		case "text":
			return "text, read whole";
		default:
			return `a ${type.kind}`;
	}
}
