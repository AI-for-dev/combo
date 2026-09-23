/**
 * Cutting a condition into tokens, in CEL's lexical rules and no further.
 *
 * Everything refused here is refused because CEL would read it differently or
 * because the subset leaves it out, and the message says which: a node id with
 * a dash is subtraction in CEL, so it is refused where it is written rather
 * than read as arithmetic a real CEL library would evaluate.
 */

/** One token, with where it sits in the source so a message can quote it. */
export type Token = {
	readonly kind: "name" | "number" | "string" | "op" | "end";
	readonly text: string;
	/** A number's or a string's value, unescaped. */
	readonly value?: number | string;
	readonly start: number;
	readonly end: number;
};

/** A condition that is not in the language. Thrown inside the module, returned as a problem at its door. */
export class SyntaxFault extends Error {}

/**
 * Words CEL keeps for itself. None can name a node or a field a condition
 * reads, so a flow that uses one is refused rather than handed to a CEL
 * library that would refuse it later.
 */
const RESERVED = new Set([
	"as", "break", "const", "continue", "else", "false", "for", "function", "if", "import", "in",
	"let", "loop", "namespace", "null", "package", "return", "true", "var", "void", "while",
]);

/** The operators of the subset, longest first so `<=` is not read as `<`. */
const OPERATORS = ["&&", "||", "==", "!=", "<=", ">=", "<", ">", "!", "(", ")", "[", "]", ".", ","];

/** Operators CEL has and the subset does not, with the reason given to the author. */
const LEFT_OUT: Record<string, string> = {
	"+": "there is no arithmetic",
	"*": "there is no arithmetic",
	"/": "there is no arithmetic",
	"%": "there is no arithmetic",
	"?": "there is no ternary: branching is a choice's",
	":": "there is no ternary: branching is a choice's",
	"{": "there are no map literals",
};

const ESCAPES: Record<string, string> = { "\\": "\\", '"': '"', "'": "'", n: "\n", r: "\r", t: "\t" };

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const NUMBER = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/;

/** Whether a word can name something a condition reads. */
export function isReserved(word: string): boolean {
	return RESERVED.has(word);
}

/** The tokens of `source`, ending with one `end` token. Throws `SyntaxFault`. */
export function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const c = source[i] as string;
		if (/\s/.test(c)) {
			i++;
		} else if (NAME_START.test(c)) {
			i = name(source, i, tokens);
		} else if (DIGIT.test(c)) {
			const text = (NUMBER.exec(source.slice(i)) as RegExpExecArray)[0];
			tokens.push({ kind: "number", text, value: Number(text), start: i, end: i + text.length });
			i += text.length;
		} else if (c === '"' || c === "'") {
			i = string(source, i, tokens);
		} else if (c === "-") {
			i = negative(source, i, tokens);
		} else {
			const op = OPERATORS.find((o) => source.startsWith(o, i));
			if (op === undefined) {
				const why = LEFT_OUT[c] ?? (c === "=" ? "equality is `==`" : c === "&" || c === "|" ? "`&&` and `||` are doubled" : "it is not in the language");
				throw new SyntaxFault(`\`${c}\` at ${i + 1}: ${why}`);
			}
			tokens.push({ kind: "op", text: op, start: i, end: i + op.length });
			i += op.length;
		}
	}
	tokens.push({ kind: "end", text: "", start: source.length, end: source.length });
	return tokens;
}

function name(source: string, start: number, tokens: Token[]): number {
	let i = start;
	while (i < source.length && NAME_PART.test(source[i] as string)) i++;
	// `ask-next` is `ask - next` to CEL, and a CEL library would evaluate it as
	// such. Said here, where the dash is, rather than as "no arithmetic".
	if (source[i] === "-" && NAME_START.test(source[i + 1] ?? "")) {
		let j = i + 1;
		while (j < source.length && (NAME_PART.test(source[j] as string) || source[j] === "-")) j++;
		const word = source.slice(start, j);
		throw new SyntaxFault(`\`${word}\`: a name a condition reads is letters, digits and \`_\`, since CEL reads a dash as subtraction; name it \`${word.replaceAll("-", "_")}\``);
	}
	tokens.push({ kind: "name", text: source.slice(start, i), start, end: i });
	return i;
}

function string(source: string, start: number, tokens: Token[]): number {
	const quote = source[start] as string;
	let value = "";
	let i = start + 1;
	while (i < source.length && source[i] !== quote) {
		const c = source[i] as string;
		if (c === "\n") break;
		if (c === "\\") {
			const escaped = ESCAPES[source[i + 1] ?? ""];
			if (escaped === undefined) throw new SyntaxFault(`\`\\${source[i + 1] ?? ""}\` at ${i + 1}: the escapes are \\\\ \\" \\' \\n \\r \\t`);
			value += escaped;
			i += 2;
		} else {
			value += c;
			i++;
		}
	}
	if (source[i] !== quote) throw new SyntaxFault(`the string opened at ${start + 1} is not closed`);
	tokens.push({ kind: "string", text: source.slice(start, i + 1), value, start, end: i + 1 });
	return i + 1;
}

/** A minus is only ever part of a number: CEL reads `-1` as a literal's negation, and there is no subtraction. */
function negative(source: string, start: number, tokens: Token[]): number {
	const match = NUMBER.exec(source.slice(start + 1));
	if (match === null) throw new SyntaxFault(`\`-\` at ${start + 1}: there is no arithmetic`);
	const text = `-${match[0]}`;
	tokens.push({ kind: "number", text, value: Number(text), start, end: start + text.length });
	return start + text.length;
}
