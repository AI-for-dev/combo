/**
 * The type of a value a flow passes around: what a schema declares, what a
 * condition is checked against, and what a node's typed output must match.
 *
 * One model for every reader. A schema is written in a short notation or a
 * closed JSON Schema subset, and both land here, so a condition, a `map-from`
 * and the `submit` tool all ask the same question of the same shape.
 *
 * There is no `any` and no `null`. A value a flow cannot name the shape of is
 * text, and text is read by an agent, never by a structural node.
 */

/** A value's type. Plain data, so a checked flow can be written down as it is. */
export type ValueType =
	| { readonly kind: "string" }
	| { readonly kind: "number" }
	| { readonly kind: "boolean" }
	/** A closed set of strings. Compared strictly: a literal outside it is refused. */
	| { readonly kind: "enum"; readonly values: readonly string[] }
	| { readonly kind: "list"; readonly of: ValueType }
	| { readonly kind: "object"; readonly fields: Readonly<Record<string, Field>> };

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
