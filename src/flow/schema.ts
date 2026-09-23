/**
 * A schema as a flow's author writes it, read into the one type model.
 *
 * Two notations, one result. The short one is YAML read as a type: `string`,
 * `number`, `boolean`, `a | b | c` for an enum, `[<schema>]` for a list,
 * `{ field: <schema>, optional?: <schema> }` for an object, and the named
 * `Question`. The long one, `{ json-schema: <subset> }`, is for what the short
 * one cannot say, which is a description for the model filling the value; it
 * takes `type`, `properties`, `required`, `items`, `enum` and `description`,
 * and nothing else.
 *
 * Both are closed. Anything outside them is refused with the path inside the
 * schema and what would have been accepted, never read as "any": a value a
 * flow cannot name the shape of is text.
 */

import type { Field, ValueType } from "./type.ts";

/** One reason a schema is refused. `at` is the path inside the schema, `""` at its root. */
export type SchemaProblem = { readonly code: "schema-invalid"; readonly at: string; readonly message: string };

/** The outcome of reading a schema: its type, or every problem found in it. */
export type ReadSchema = { readonly ok: true; readonly type: ValueType } | { readonly ok: false; readonly problems: readonly SchemaProblem[] };

const STRING: ValueType = { kind: "string" };

/** The question an `ask-from` puts to a person, in the shape the card draws. */
export const QUESTION: ValueType = {
	kind: "object",
	fields: {
		header: { type: STRING, optional: true },
		question: { type: STRING, optional: false },
		options: {
			type: {
				kind: "list",
				of: { kind: "object", fields: { label: { type: STRING, optional: false }, description: { type: STRING, optional: true } } },
			},
			optional: false,
		},
	},
};

const NAMED: Readonly<Record<string, ValueType>> = { string: STRING, number: { kind: "number" }, boolean: { kind: "boolean" }, Question: QUESTION };

const LONG_KEY = "json-schema";
const LONG_KEYWORDS = ["type", "properties", "required", "items", "enum", "description"];
const LONG_TYPES = ["string", "number", "boolean", "array", "object"];

/**
 * A field name: what an address and a condition read, so it is a CEL
 * identifier. A dot would split an address, and a dash is subtraction to CEL.
 */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `written`, as YAML parsed it, read as a schema in either notation. */
export function readSchema(written: unknown): ReadSchema {
	const problems: SchemaProblem[] = [];
	const type = short(written, "", problems);
	return type === undefined || problems.length > 0 ? { ok: false, problems } : { ok: true, type };
}

function short(written: unknown, at: string, problems: SchemaProblem[]): ValueType | undefined {
	if (typeof written === "string") return word(written, at, problems);
	if (Array.isArray(written)) {
		if (written.length !== 1) return refuse(problems, at, "a list is written `[<schema>]`, with exactly one schema inside");
		return listOf(short(written[0], `${at}[]`, problems));
	}
	if (!isRecord(written)) return refuse(problems, at, `${JSON.stringify(written ?? null)} is not a schema; write a type name, \`a | b\`, \`[<schema>]\` or \`{ field: <schema> }\``);
	if (LONG_KEY in written) {
		if (Object.keys(written).length > 1) return refuse(problems, at, `\`${LONG_KEY}\` stands alone: a short object cannot have a field named so`);
		return long(written[LONG_KEY], join(at, LONG_KEY), problems);
	}
	const entries = Object.entries(written);
	if (entries.length === 0) return refuse(problems, at, "an object has at least one field");
	const fields: Record<string, Field> = {};
	for (const [key, value] of entries) {
		const optional = key.endsWith("?");
		const name = optional ? key.slice(0, -1) : key;
		const type = field(name, at, problems) ? short(value, join(at, name), problems) : undefined;
		if (type !== undefined) fields[name] = { type, optional };
	}
	return { kind: "object", fields };
}

/** A type name, or an enum written `a | b | c`. */
function word(written: string, at: string, problems: SchemaProblem[]): ValueType | undefined {
	const named = NAMED[written.trim()];
	if (named !== undefined) return named;
	if (!written.includes("|")) {
		return refuse(problems, at, `unknown type \`${written}\`; the types are ${Object.keys(NAMED).join(", ")}, or an enum written \`a | b\``);
	}
	return enumOf(written.split("|").map((value) => value.trim()), at, problems, "an enum");
}

function long(written: unknown, at: string, problems: SchemaProblem[]): ValueType | undefined {
	if (!isRecord(written)) return refuse(problems, at, "a JSON Schema is an object");
	const unknown = Object.keys(written).filter((key) => !LONG_KEYWORDS.includes(key));
	if (unknown.length > 0) return refuse(problems, at, `${unknown.map((k) => `\`${k}\``).join(", ")}: the keywords are ${LONG_KEYWORDS.join(", ")}`);
	const { type, properties, required, items, enum: values, description } = written;
	if (description !== undefined && typeof description !== "string") return refuse(problems, join(at, "description"), "a description is a string");
	const described = (t: ValueType | undefined): ValueType | undefined => t && (description === undefined ? t : { ...t, description });
	if (typeof type !== "string" || !LONG_TYPES.includes(type)) return refuse(problems, join(at, "type"), `\`type\` is one of ${LONG_TYPES.join(", ")}`);
	const misplaced = (
		[
			["properties", properties, "object"],
			["required", required, "object"],
			["items", items, "array"],
			["enum", values, "string"],
		] as const
	).filter(([, value, owner]) => value !== undefined && owner !== type);
	if (misplaced.length > 0) return refuse(problems, at, misplaced.map(([key, , owner]) => `\`${key}\` belongs to \`type: ${owner}\``).join("; "));
	switch (type) {
		case "array":
			if (items === undefined) return refuse(problems, at, "`type: array` needs `items`");
			return described(listOf(long(items, join(at, "items"), problems)));
		case "object":
			return described(object(properties, required, at, problems));
		case "string":
			if (values === undefined) return described(STRING);
			if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) return refuse(problems, join(at, "enum"), "`enum` is a list of strings");
			return described(enumOf(values as string[], join(at, "enum"), problems, "`enum`"));
		default:
			return described(NAMED[type]);
	}
}

function object(properties: unknown, required: unknown, at: string, problems: SchemaProblem[]): ValueType | undefined {
	if (!isRecord(properties) || Object.keys(properties).length === 0) return refuse(problems, join(at, "properties"), "`type: object` needs `properties`, with at least one");
	if (required !== undefined && (!Array.isArray(required) || required.some((r) => typeof r !== "string"))) {
		return refuse(problems, join(at, "required"), "`required` is a list of property names");
	}
	const needed = (required ?? []) as string[];
	const stray = needed.filter((name) => !(name in properties));
	if (stray.length > 0) return refuse(problems, join(at, "required"), `${stray.map((s) => `\`${s}\``).join(", ")} is not among the properties`);
	const fields: Record<string, Field> = {};
	for (const [name, value] of Object.entries(properties)) {
		const type = field(name, at, problems) ? long(value, join(at, `properties.${name}`), problems) : undefined;
		if (type !== undefined) fields[name] = { type, optional: !needed.includes(name) };
	}
	return { kind: "object", fields };
}

function enumOf(values: readonly string[], at: string, problems: SchemaProblem[], what: string): ValueType | undefined {
	if (values.length < 2 || values.some((value) => value === "")) return refuse(problems, at, `${what} has at least two values, none empty`);
	const repeated = values.filter((value, i) => values.indexOf(value) !== i);
	if (repeated.length > 0) return refuse(problems, at, `${what} names ${repeated.map((v) => `\`${v}\``).join(", ")} twice`);
	return { kind: "enum", values };
}

function field(name: string, at: string, problems: SchemaProblem[]): boolean {
	if (FIELD_NAME.test(name)) return true;
	refuse(problems, join(at, name), `\`${name}\`: a field name is letters, digits and \`_\`, since an address and a condition read it`);
	return false;
}

function listOf(of: ValueType | undefined): ValueType | undefined {
	return of && { kind: "list", of };
}

function refuse(problems: SchemaProblem[], at: string, message: string): undefined {
	problems.push({ code: "schema-invalid", at, message });
	return undefined;
}

function join(at: string, key: string): string {
	return at === "" ? key : `${at}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
