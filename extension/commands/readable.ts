/**
 * A flow's output as the conversation reads it, the person and the model alike.
 *
 * Text is kept as it is. A typed value is written as Markdown rather than as
 * JSON: a JSON string holds its line breaks as `\n`, so a plan's step, a
 * review's remarks or any text an agent submitted read as one escaped line.
 * Here an object is one item per field, and a text of several lines sits under
 * its key with its lines, lists and code intact. A list of objects is numbered,
 * each field a paragraph of its item: pi draws no number for an item that opens
 * on a list, and the items would run into each other.
 */

/** `value` as Markdown: text as it is, a typed value as nested lists. */
export function readable(value: unknown): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : lines(value).join("\n");
}

function lines(value: unknown): string[] {
	if (!isNested(value)) return isEmpty(value) ? ["_empty_"] : String(value).trimEnd().split("\n");
	if (!Array.isArray(value)) return Object.entries(value as object).flatMap(([key, field]) => bullet(key, field));
	if (!value.some(isRecord)) return value.flatMap((item) => under("- ", lines(item)));
	return value.flatMap((item, index) => [...(index === 0 ? [] : [""]), ...under(`${index + 1}. `, isRecord(item) ? paragraphs(item) : lines(item))]);
}

/** One field as a list item: a one-line value beside its key, anything longer under it. */
function bullet(key: string, field: unknown): string[] {
	const body = lines(field);
	if (!isNested(field) && body.length === 1) return [`- **${key}**: ${body[0]}`];
	// A paragraph of its own, or the text's first line would run on after the key.
	return [`- **${key}**:`, ...(isNested(field) ? [] : [""]), ...body.map((line) => pad(line, 2))];
}

/** An object's fields as paragraphs, for an item of a numbered list. */
function paragraphs(record: object): string[] {
	return Object.entries(record).flatMap(([key, field], index) => {
		const body = lines(field);
		const one = !isNested(field) && body.length === 1 ? [`**${key}**: ${body[0]}`] : [`**${key}**:`, "", ...body];
		return [...(index === 0 ? [] : [""]), ...one];
	});
}

/** `body` as one list item: `marker` on its first line, the others aligned under it. */
function under(marker: string, body: string[]): string[] {
	return body.map((line, index) => (index === 0 ? `${marker}${line}` : pad(line, marker.length)));
}

function pad(line: string, width: number): string {
	return line === "" ? "" : `${" ".repeat(width)}${line}`;
}

/** An array or an object with something in it: written as a list. */
function isNested(value: unknown): boolean {
	return typeof value === "object" && value !== null && !isEmpty(value);
}

function isRecord(value: unknown): value is object {
	return isNested(value) && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
	return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}
