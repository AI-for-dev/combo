/**
 * Reading what a model wrote: shortening it, and finding the structure in it.
 *
 * One concept, not a grab-bag: every function here takes free-form assistant
 * text and makes something reliable out of it. They were each written three to
 * five times across the workflows, the reporters and the extension, and the
 * copies had already started to drift - one `truncate` that trimmed and one that
 * did not, two identical brace scanners maintained apart.
 *
 * A model does not answer in a format. It answers in prose with the format
 * somewhere inside, decorated with whatever markdown it felt like adding, which
 * is why these are lenient by design.
 */

/**
 * One line, whitespace flattened, at most `max` characters with an ellipsis.
 *
 * `max` has no default on purpose: the width belongs to whoever is drawing, and
 * a shared default would be the one number nobody chose.
 */
export function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The first line, or `""`. What a collapsed row shows of a command. */
export function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

/** A value as text: strings as they are, anything else as JSON, never `undefined`. */
export function scalar(value: unknown): string {
	return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/**
 * Whether `word` stands alone on one of the lines.
 *
 * The convention three workflows depend on - `LGTM`, `APPROVED`, `READY` - and
 * the reason it is lenient: a model that has been told to answer with one word
 * still writes `**LGTM**`, `## APPROVED` or `READY.`, and a strict match would
 * loop forever waiting for a verdict already given. Decoration is stripped, case
 * is ignored; a line with anything else on it still does not count.
 */
export function saysWord(output: string, word: string): boolean {
	return output
		.trim()
		.split("\n")
		.some((line) => line.replace(/[*_`#\s.]/g, "").toUpperCase() === word.toUpperCase());
}

/**
 * Every top-level JSON object in `output`, parsed, in order.
 *
 * A balanced-brace scan rather than a regular expression, because the objects
 * are nested and a regex cannot count. Strings and their escapes are tracked, so
 * a `}` inside a quoted value does not end an object. Anything that fails to
 * parse is skipped rather than raised: the surrounding prose, the fence markers
 * and the model's own commentary are all expected here.
 */
export function* jsonObjects(output: string): Generator<unknown> {
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < output.length; i++) {
		const char = output[i];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') inString = true;
		else if (char === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (char === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				try {
					yield JSON.parse(output.slice(start, i + 1));
				} catch {
					// not JSON after all - keep scanning
				}
				start = -1;
			}
		}
	}
}
