/**
 * A condition's tree, parsed with CEL's grammar and precedence.
 *
 * The subset is CEL's own grammar with productions removed, never one of ours
 * added, so every expression this accepts parses the same way in a real CEL
 * library: `!a == b` is `(!a) == b`, and relations sit below `&&`.
 */

import { isReserved, SyntaxFault, tokenize, type Token } from "./tokens.ts";

/** Where a node of the tree sits in the source, so a message can quote exactly that part. */
export type Span = { readonly start: number; readonly end: number };

/** The operators that take two sides. */
export type BinaryOperator = "&&" | "||" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "in";

/** One node of a condition's tree. */
export type Expr = Span &
	(
		| { readonly kind: "literal"; readonly value: boolean | number | string }
		| { readonly kind: "list"; readonly items: readonly Expr[] }
		| { readonly kind: "name"; readonly name: string }
		| { readonly kind: "select"; readonly target: Expr; readonly field: string }
		| { readonly kind: "not"; readonly operand: Expr }
		| { readonly kind: "binary"; readonly op: BinaryOperator; readonly left: Expr; readonly right: Expr }
		| { readonly kind: "size"; readonly arg: Expr }
		| { readonly kind: "has"; readonly arg: Expr & { readonly kind: "select" } }
		| { readonly kind: "macro"; readonly macro: "all" | "exists"; readonly target: Expr; readonly variable: string; readonly body: Expr }
	);

const RELATIONS = new Set(["==", "!=", "<", "<=", ">", ">=", "in"]);

/** The tree of `source`. Throws `SyntaxFault`, which the module's door turns into a problem. */
export function parse(source: string): Expr {
	const parser = new Parser(tokenize(source));
	const expr = parser.or();
	parser.expectEnd();
	return expr;
}

class Parser {
	private i = 0;
	private readonly tokens: Token[];

	constructor(tokens: Token[]) {
		this.tokens = tokens;
	}

	or(): Expr {
		return this.leftAssociative(["||"], () => this.and());
	}

	expectEnd(): void {
		const t = this.peek();
		if (t.kind !== "end") throw this.unexpected(t);
	}

	private and(): Expr {
		return this.leftAssociative(["&&"], () => this.relation());
	}

	private relation(): Expr {
		return this.leftAssociative([...RELATIONS], () => this.unary());
	}

	private leftAssociative(ops: string[], next: () => Expr): Expr {
		let left = next();
		for (;;) {
			const t = this.peek();
			// `in` is a word, the only operator that lexes as a name.
			const operator = t.kind === "op" || (t.kind === "name" && t.text === "in");
			if (!operator || !ops.includes(t.text)) break;
			this.i++;
			const right = next();
			left = { kind: "binary", op: t.text as BinaryOperator, left, right, start: left.start, end: right.end };
		}
		return left;
	}

	private unary(): Expr {
		const t = this.peek();
		if (t.kind === "op" && t.text === "!") {
			this.i++;
			const operand = this.unary();
			return { kind: "not", operand, start: t.start, end: operand.end };
		}
		return this.member();
	}

	private member(): Expr {
		let expr = this.primary();
		while (this.peek().text === "." && this.peek().kind === "op") {
			this.i++;
			const field = this.identifier();
			if (this.peek().text === "(") {
				expr = this.method(expr, field);
			} else {
				expr = { kind: "select", target: expr, field: field.text, start: expr.start, end: field.end };
			}
		}
		return expr;
	}

	private method(target: Expr, name: Token): Expr {
		if (name.text !== "all" && name.text !== "exists") {
			throw new SyntaxFault(`\`.${name.text}()\`: the macros are \`all\` and \`exists\`${name.text === "size" ? ", and size is written `size(x)`" : ""}`);
		}
		this.expect("(");
		const variable = this.identifier();
		this.expect(",");
		const body = this.or();
		const close = this.expect(")");
		return { kind: "macro", macro: name.text, target, variable: variable.text, body, start: target.start, end: close.end };
	}

	private primary(): Expr {
		const t = this.next();
		if (t.kind === "number" || t.kind === "string") return { kind: "literal", value: t.value as number | string, start: t.start, end: t.end };
		if (t.kind === "name") {
			if (t.text === "true" || t.text === "false") return { kind: "literal", value: t.text === "true", start: t.start, end: t.end };
			if (this.peek().text === "(") return this.call(t);
			return { kind: "name", name: this.checkedName(t), start: t.start, end: t.end };
		}
		if (t.text === "(") {
			const inner = this.or();
			this.expect(")");
			return inner;
		}
		if (t.text === "[") return this.list(t);
		throw this.unexpected(t);
	}

	private call(name: Token): Expr {
		if (name.text !== "size" && name.text !== "has") {
			throw new SyntaxFault(`\`${name.text}()\`: the functions are \`size\` and \`has\``);
		}
		this.expect("(");
		const arg = this.or();
		const close = this.expect(")");
		if (name.text === "size") return { kind: "size", arg, start: name.start, end: close.end };
		if (arg.kind !== "select") throw new SyntaxFault("`has()` takes a field, as in `has(node.output.field)`");
		return { kind: "has", arg, start: name.start, end: close.end };
	}

	private list(open: Token): Expr {
		const items: Expr[] = [];
		while (this.peek().text !== "]") {
			items.push(this.or());
			if (this.peek().text !== ",") break;
			this.i++;
		}
		const close = this.expect("]");
		return { kind: "list", items, start: open.start, end: close.end };
	}

	private identifier(): Token {
		const t = this.next();
		if (t.kind !== "name") throw this.unexpected(t);
		this.checkedName(t);
		return t;
	}

	private checkedName(t: Token): string {
		if (isReserved(t.text)) throw new SyntaxFault(`\`${t.text}\` is a word CEL reserves, so no node or field read by a condition can be named so`);
		return t.text;
	}

	private expect(text: string): Token {
		const t = this.next();
		if (t.text !== text || t.kind !== "op") throw this.unexpected(t, text);
		return t;
	}

	private peek(): Token {
		return this.tokens[this.i] as Token;
	}

	private next(): Token {
		const t = this.peek();
		if (t.kind !== "end") this.i++;
		return t;
	}

	private unexpected(t: Token, wanted?: string): SyntaxFault {
		const found = t.kind === "end" ? "the end" : `\`${t.text}\` at ${t.start + 1}`;
		return new SyntaxFault(wanted === undefined ? `unexpected ${found}` : `expected \`${wanted}\`, found ${found}`);
	}
}
