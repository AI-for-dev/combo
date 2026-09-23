/**
 * The type of a value a flow passes around: what a schema declares, what a
 * condition is checked against, and what a node's typed output must match.
 *
 * One model for every reader. A schema is written in a short notation or a
 * closed JSON Schema subset, and both land here, so a condition, a `map-from`
 * and the `submit` tool all ask the same question of the same shape.
 *
 * There is no `any` and no `null`. A value a flow cannot name the shape of is
 * `text`: what an agent wrote with no `output:` schema. An agent reads it; a
 * condition never does, since a decision read out of prose is a guess.
 */

/**
 * A value's type. Plain data, so a checked flow can be written down as it is.
 *
 * `description` is what the author wrote for the model that fills the value;
 * it changes nothing about what matches.
 */
export type ValueType = { readonly description?: string } & (
	| { readonly kind: "text" }
	| { readonly kind: "string" }
	| { readonly kind: "number" }
	| { readonly kind: "boolean" }
	/** A closed set of strings. Compared strictly: a literal outside it is refused. */
	| { readonly kind: "enum"; readonly values: readonly string[] }
	| { readonly kind: "list"; readonly of: ValueType }
	| { readonly kind: "object"; readonly fields: Readonly<Record<string, Field>> }
);

/** One field of an object. An optional one may be absent, and reading it then is an error. */
export type Field = { readonly type: ValueType; readonly optional: boolean };

/**
 * A type in the short notation a flow's author writes it in: `string`,
 * `a | b`, `[number]`, `{ passed: boolean, report?: string }`.
 *
 * Messages quote types this way, so a refusal reads in the words of the file.
 */
export function showType(type: ValueType): string {
	switch (type.kind) {
		case "enum":
			return type.values.join(" | ");
		case "list":
			return `[${showType(type.of)}]`;
		case "object": {
			const fields = Object.entries(type.fields).map(([name, f]) => `${name}${f.optional ? "?" : ""}: ${showType(f.type)}`);
			return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
		}
		default:
			return type.kind;
	}
}

/** Whether two types match the same values. A description changes nothing about what matches. */
export function sameType(a: ValueType, b: ValueType): boolean {
	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case "enum":
			return b.kind === "enum" && a.values.length === b.values.length && a.values.every((value) => b.values.includes(value));
		case "list":
			return b.kind === "list" && sameType(a.of, b.of);
		case "object": {
			if (b.kind !== "object") return false;
			const names = Object.keys(a.fields);
			if (names.length !== Object.keys(b.fields).length) return false;
			return names.every((name) => {
				const [x, y] = [a.fields[name], b.fields[name]];
				return x !== undefined && y !== undefined && x.optional === y.optional && sameType(x.type, y.type);
			});
		}
		default:
			return true;
	}
}

/**
 * Why `value` is not of `type`, or `undefined` when it is.
 *
 * Values are JSON-shaped: an absent field is `undefined`, and an object has
 * no field its type does not name, since a key nobody declared is one no
 * address can read. This is the one check a typed value passes, whether a
 * model submitted it or a dry run's script wrote it.
 */
export function mismatch(value: unknown, type: ValueType, at = ""): string | undefined {
	const where = at === "" ? "the value" : `\`${at}\``;
	const off = () => `${where} is ${JSON.stringify(value) ?? "absent"}, not ${showType(type)}`;
	switch (type.kind) {
		case "text":
		case "string":
			return typeof value === "string" ? undefined : off();
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? undefined : off();
		case "boolean":
			return typeof value === "boolean" ? undefined : off();
		case "enum":
			return typeof value === "string" && type.values.includes(value) ? undefined : off();
		case "list":
			if (!Array.isArray(value)) return off();
			for (const [index, item] of value.entries()) {
				const problem = mismatch(item, type.of, `${at}[${index}]`);
				if (problem !== undefined) return problem;
			}
			return undefined;
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return off();
			const record = value as Record<string, unknown>;
			const stray = Object.keys(record).find((name) => !(name in type.fields) && record[name] !== undefined);
			if (stray !== undefined) return `${where} has \`${stray}\`, which ${showType(type)} does not name`;
			for (const [name, field] of Object.entries(type.fields)) {
				const place = at === "" ? name : `${at}.${name}`;
				if (record[name] === undefined) {
					if (!field.optional) return `\`${place}\` is missing`;
					continue;
				}
				const problem = mismatch(record[name], field.type, place);
				if (problem !== undefined) return problem;
			}
			return undefined;
		}
	}
}
